const fs = require('fs-extra')
const cbor = require('borc')
const crypto = require('crypto')

const VectorLibrary = require('../vector-library/library')
const SearchLibrary = require('../search-library/library-node')
const MediaCache = require('../search-library/media-cache')
const englishTextFilter = require('../vector-library/text-filter-english')

const PQueue = require('p-queue').default
const parseDuration = require('parse-duration')
const prettyMs = require('pretty-ms')
const lockfile = require('proper-lockfile')
const Feed = require('feed').Feed
const html = require('nanohtml')
const objectHash = require('object-hash')
const dateFNS = require('date-fns')
const ProgressBar = require('progress')
const stripJsonComments = require('strip-json-comments')

const OnDemandMediaLoader = require('./on-demand-media-loader')
const SpiderConductor = require('./conductor')

// SpiderNest coordinates a collection of configured web spiders and executes their tasks with reasonable concurrency
class SpiderNest {
  constructor(settings) {
    this.settings = settings
    this.loaded = false
    this.timestamps = {}
    this.buildTimestampsFile = `${this.settings.spiderPath}/frozen-data/build-timestamps.cbor`
    this.writeQueue = new PQueue({ concurrency: 1 })
    this.content = {}
    this.log = (...args)=> console.log(...args)
  }

  // load data and lock timestamps file to signify the spider is running
  async load() {
    if (this.loaded) return
    this.configs = JSON.parse(stripJsonComments((await fs.readFile(`${this.settings.spiderPath}/configs.json`)).toString()))
    this.vectorDB = await (new VectorLibrary({
      path: this.settings.vectorDBPath,
      fs, digest: async (algo, data)=> {
        let hash = crypto.createHash(algo)
        hash.update(data)
        return new Uint8Array(hash.digest())
      },
      textFilter: englishTextFilter
    })).open()

    await fs.ensureDir(this.settings.logsPath)
    
    if (await fs.pathExists(this.buildTimestampsFile)) {
      this.buildTimestampsLock = await lockfile.lock(this.buildTimestampsFile)
      try {
        this.timestamps = cbor.decode(await fs.readFile(this.buildTimestampsFile))
        // remove any timestamps for spiders that aren't configured anymore
        this.timestamps = Object.fromEntries(Object.entries(this.timestamps).filter(([key, value])=> !!this.configs[key] ))

      } catch (err) { this.log(`build-timestamps.cbor is corrupt? ignoring. Error: ${err}`) }
    }

    // create SpiderConductors
    this.spiders = {}
    for (let spiderName in this.configs) {
      this.spiders[spiderName] = new SpiderConductor(this, spiderName, this.configs[spiderName])
      await this.spiders[spiderName].start()
    }

    this.loaded = true
  }

  // unlock timestamps file so another spider instance can run
  async unload() {
    if (this.buildTimestampsLock) {
      await this.buildTimestampsLock()
      this.buildTimestampsLock = null
    }
  }

  // runs all configured spiders, refreshing any content older than maxAgeString
  async runInSeries(maxAgeString) {
    // store current timestamp to time scrape step
    let startTime = Date.now()
    // iterate through configured sources
    for (let source of Object.keys(this.configs)) {
      // calculate how long ago we last spidered this source
      let sourceAge = startTime - this.timestamps[source]
      // parse out how often the source should execute
      let sourceInterval = parseDuration(this.spiders[source].config.interval || "0")
      // spider it again if it's been longer than the configured spider interval
      if (sourceAge >= sourceInterval) {
        // update timestamps file
        this.timestamps[source] = startTime
        await fs.writeFile(this.buildTimestampsFile, cbor.encode(this.timestamps))

        // run necessary spider tasks
        await this.runOneSpider(source, maxAgeString)
      } else {
        this.log(`Skipping ${source} as it is not due to run for another ${prettyMs(sourceInterval - sourceAge)}`)
      }
    }
    this.log(`Finished spidering in ${prettyMs(Date.now() - startTime)}`)
  }

  async runOneSpider(source, maxAgeString = false) {
    let maxAge = parseDuration(maxAgeString || this.spiders[source].config.expires || "1 year")

    await this.spiders[source].run(maxAge)
  }

  async buildDatasets() {
    let content = await Promise.all(Object.values(this.spiders).map(x => x.getContent()))
    let contentLength = content.reduce((prev, curr) => prev + Object.keys(curr).length, 0)

    // setup library
    let buildIDs = await Promise.all(Object.values(this.spiders).map(x => x.buildID()))
    let buildID = objectHash(buildIDs.sort(), { algorithm: 'sha256' }).slice(0, 16)
    if (await fs.pathExists(`${this.settings.datasetsPath}/${this.settings.libraryName}/definitions/${buildID}`)) {
      this.log(`Dataset already exists in current form, skipping build`)
      return false
    }
    let library = await this.getSearchLibraryWriter({
      name: this.settings.libraryName, buildID, contentLength
    })
    
    var progress = new ProgressBar(' [:bar] :rate/ips :percent :etas :spiderName :entryID', {
      total: contentLength, width: 80, head: '>', incomplete: ' ', clear: true
    })
    let oldLog = this.log
    this.log = (...args)=> progress.interrupt(args.join(' '))
    for (let spiderName in this.spiders) {
      let spider = this.spiders[spiderName]
      let spiderContent = await spider.getContent()

      // create a place to store a global collectection of reference counted source videos, to avoid downloading
      // multiple times when clipping multiple videos out of one source video
      let sourceVideoCache = {}

      // loop through accumulated content, writing it in to the searchLibrary and fetching any media necessary
      for (let entryID in spiderContent) {
        let entry = spiderContent[entryID]
        this.log(`Importing ${spiderName} ${entry.link}: ${entry.title || entry.words.join(', ')}`)

        // check if an override file exists
        let overrideObject = {}
        if (this.settings.overridesPath) {
          let overridePath = `${this.settings.overridesPath}/${spiderName}:${entryID}.json`
          if (await fs.pathExists(overridePath)) {
            this.log(`Implementing override data from ${overridePath}`)
            overrideObject = JSON.parse(await fs.readFile(overridePath))
          }
        }

        await library.addDefinition(Object.assign({
          title: entry.title || entry.words.join(', '),
          keywords: entry.words,
          tags: [...(spider.config.tags || []), ...(entry.tags || [])].filter((v,i,a) => a.indexOf(v) === i).map(x => `${x}`.toLowerCase()),
          link: entry.link,
          body: entry.body,
          media: entry.videos.map(videoInfo => new OnDemandMediaLoader({ spider: spider.spider, sourceVideoCache, spiderName, videoInfo, log: this.log })),
          provider: spiderName,
          id: entryID
        }, overrideObject))
        progress.tick({ spiderName, entryID })
      }

      // cleanup source videos
      await Promise.all(Object.values(sourceVideoCache).map(path => fs.remove(path) ))
    }
    this.log = oldLog

    // save the dataset out to the filesystem from memory
    await library.save()
    // cleanup any unreferenced/unused files in the dataset
    await library.cleanup()
    

    return true
  }

  // creates a SearchLibraryWriter for the SpiderConductor to use to do a build
  async getSearchLibraryWriter({ name, buildID, contentLength }) {
    // build search library
    let libraryPath = `${this.settings.datasetsPath}/${name}`
    await fs.ensureDir(libraryPath)

    // calculate how many shardBits are needed to make each json definition block be about 15kb big
    let shardBits = 1
    while (contentLength / 30 > 2 ** shardBits) shardBits += 1
    // create a SearchLibraryWriter with reasonable values
    let searchLibrary = await (new SearchLibrary({
      path: libraryPath, vectorBits: 8, vectorLibrary: this.vectorDB, buildID, cleanupKeywords: true,
      ...this.settings.searchLibraryParams,
      log: (...args)=> this.log(...args),
      mediaCache: new MediaCache({ path: libraryPath, log: (...args)=> this.log(...args) }),
    }))

    return searchLibrary
  }

  // build a feed of newly discovered content
  async buildDiscoveryFeeds() {
    // wait for writes to finish
    await this.writeQueue.onIdle()
    // load discovery log
    let log = []
    if (await fs.pathExists(`${this.settings.datasetsPath}/update-log.cbor`)) {
      log = cbor.decodeAll(await fs.readFile(`${this.settings.datasetsPath}/update-log.cbor`))
    }

    let feedEntries = []
    let minTimestamp = Date.now() - parseDuration(this.settings.discoveryFeed.minDuration)
    while (log.length > 0 && ((feedEntries.length < this.settings.discoveryFeed.minEntries
      || (log.length > 0 && log.slice(-1)[0].timestamp > minTimestamp))
      && feedEntries.length < this.settings.discoveryFeed.maxEntries)) {
      // remove the last entry from the log, add it to the end of the feedEntries, reversing the array
      feedEntries.push(log.pop())
    }

    // build feeds
    let feed = new Feed({
      title: this.settings.discoveryFeed.title,
      description: this.settings.discoveryFeed.description,
      id: this.settings.discoveryFeed.link,
      link: this.settings.discoveryFeed.link
    })
    
    let feedHTML = ['<!-- START Discovery Feed -->']
    let lastTimestamp = new Date(0)
    feedEntries.forEach(entry => {
      let displayName = this.configs[entry.provider].displayName || entry.provider
      feed.addItem({
        id: `${entry.provider}:${entry.id}`,
        title: `${displayName} ${entry.verb} ${[...entry.words].flat(2).join(', ').trim()}`,
        link: entry.link,
        date: new Date(entry.timestamp),
        description: `${entry.body}\n...`,
        author: { name: displayName, link: this.configs[entry.provider].providerLink },
      })
      
      let timestamp = new Date(entry.timestamp)
      if (timestamp.toLocaleDateString() != lastTimestamp.toLocaleDateString()) {
        feedHTML.push(html`<h2><time datetime="${dateFNS.format(timestamp, "yyyy-MM-dd")}">${dateFNS.format(timestamp, "EEEE, do LLLL yyyy")}</time></h2>`)
        lastTimestamp = timestamp
      }
      feedHTML.push(html`<div class=discovery_link><a href="${entry.providerLink}">${displayName}</a> ${entry.verb || 'documented'} <a href="${entry.link}">${[...entry.words].flat(2).slice(0,3).join(', ').trim()}</a></div>`)
    })
    feedHTML.push('<!-- END Discovery Feed -->')

    let updatedHTML = (await fs.readFile(this.settings.searchUIPath)).toString()
    updatedHTML = updatedHTML.replace(/ +<!-- START Discovery Feed -->(.+)<!-- END Discovery Feed -->\n/s, ()=> feedHTML.map(x => `      ${x}\n`).join(""))

    // write out feeds
    await Promise.all([
      fs.writeFile(`${this.settings.feedsPath}/discovery.rss`, feed.rss2()),
      fs.writeFile(`${this.settings.feedsPath}/discovery.atom`, feed.atom1()),
      fs.writeFile(`${this.settings.feedsPath}/discovery.json`, feed.json1()),
      fs.writeFile(`${this.settings.searchUIPath}`, updatedHTML)
    ])
  }
}

module.exports = SpiderNest