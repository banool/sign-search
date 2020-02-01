const fs = require('fs-extra')
const util = require('util')
const createTorrent = util.promisify(require('create-torrent'))
const HandbrakeEncoder = require('../lib/search-library/encoder-handbrake')

const SpiderNest = require('../lib/search-spider/nest')


let defaultRun = async () => {
  let nest = new SpiderNest({
    spiderPath: './spiders', // path to spiders directory, containing implementations of each spider type, and where frozen-data is stored
    vectorDBPath: '../datasets/cc-en-300-8bit', // path to word vector library
    datasetsPath: '../datasets', // path to datasets folder
    feedsPath: '../feeds', // path to directory where generated discovery feeds are written
    logsPath: '../logs', // path to logs directory
    searchUIPath: '../index.html', // relative path to index.html file, to write discovery log to
    libraryName: 'search-index', // should the datasets be combined in to one build? what should it be called?
    overridesPath: './spiders/overrides', // directory which has "{search result uri}.json" format, which overrides values the spider fetched on specific results
    writeFrequently: true,
    searchLibraryParams: {
      vectorBits: 6,
      mediaFormats: [
        new HandbrakeEncoder(),
        //new HandbrakeEncoder({ maxWidth: 1280, maxHeight: 720, quality: 25 }) // 720p build
      ],
    },
    discoveryFeed: {
      minEntries: 12,
      minDuration: '1 month',
      maxEntries: 24,
      title: "Discovered Signs",
      description: "Signs that have recently been discovered by Find Sign’s robotic spiders as they explore the Auslan web",
      id: "https://find.auslan.fyi/",
      link: "https://find.auslan.fyi/"
    }
  })
  
  // load data and lock file
  await nest.load()
  
  // run in series does one spider at a time
  await nest.runInSeries()
  // run a single specific spider, and force the scrape
  // await nest.runOneSpider('signbank')
  // await nest.runOneSpider('asphyxia')
  // await nest.runOneSpider('community')
  // await nest.runOneSpider('signpedia')
  // await nest.runOneSpider('stage-left')
  // await nest.runOneSpider('toddslan')
  // await nest.runOneSpider('v-alford')

  // rebuild the search libraries / common search library
  let didRebuild = await nest.buildDatasets()

  await nest.buildDiscoveryFeeds()

  if (didRebuild) {
    // if anything changed about the search index, rebuild the datasets torrent
    console.log(`Datasets changed, rebuilding datasets.torrent`)
    
    var opts = {
      name: "datasets",
      comment: "Find Sign (Australian Sign Language Search Engine) live datasets directory",
      createdBy: "WebTorrent: tools/spider.js",
      urlList: ["https://find.auslan.fyi/"]
    }

    console.log("Creating torrent...")
    let torrent = await createTorrent('../datasets', opts)
    await fs.writeFile('../datasets.torrent', torrent)
    console.log("datasets.torrent updated")
  }

  // unlock spider files
  await nest.unload()
}

defaultRun()