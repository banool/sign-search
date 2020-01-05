// Scraper to load video content from SignBank websites like Auslan Signbank
const util = require('util')
const fs = require('fs-extra')
const Spider = require('../../lib/spider.js')

// A spider which indexes an instagram feed and creates a produces a search index from that content
// default config should be:
// {
//   "spider": "signbank",
//   "domain": "https://www.auslan.org.au/",
//   "timeout": 60
// }
class SignBankSpider extends Spider {
  constructor(config, ...args) {
    super(config, ...args)
  }

  beforeStart() {
    this.erase() // always erase the content and do a fresh build with signbank
  }
  
  // scrape task routing function, detects type of scrape task requested and routes to appropriate internal function
  async index(task = false, ...args) {
    if (!task) {
      // root scrape
      return this.indexAlphabet(...args)
    } else if (task == 'search') {
      // scrape a search result page
      return this.indexSearchResults(...args)
    } else if (task == 'definition') {
      // scrape a definition page
      return this.indexDefinitionPage(...args)
    } else {
      throw new Error(`Unknown task ${util.inspect([task, ...args])}`)
    }
  }

  // handles root scrape - it loads the dictionary root page, and indexes the alphabet links, generating tasks to read those search result pages
  async indexAlphabet() {
    let tasks = []

    let url = this.relativeLink(this.config.domain, '/dictionary/')
    let page = await this.openWeb(url)
    page(".alphablock ul li a").each((i, link) => {
      tasks.push([ 'search', this.relativeLink(url, link.attribs.href) ])
    })

    return { tasks }
  }

  // scrapes search result pages, discovering links to other content like definitions and other search result pages
  async indexSearchResults(url) {
    let tasks = []

    // load search results page
    let page = await this.openWeb(url)
    
    // extract links to definitions in search results
    page("table.table a").each((i, link) => {
      tasks.push([ 'definition', this.relativeLink(url, link.attribs.href) ])
    })

    // extract pagination links to the rest of the search results and append them as possible tasks
    // NOTE: spider host app should skip any redundant tasks as long as they JSON serialise the same way so this wont create loops
    page("nav[aria-label='Page navigation'] ul.pagination li a").each((i, link) => {
      tasks.push([ 'search', this.relativeLink(url, link.attribs.href) ])
    })

    return { tasks }
  }

  // scrapes a definition page, and discovers links to other definition pages that should be scraped too
  // NOTE: this intentionally discovers the previous and next sign pages, to navigate around any missing content
  // since Auslan Signbank seems to display only 49 results on each search results page of 50 results
  // and to discover 'rude' signs, which are filtered in the search results view but do seem to be accessible otherwise
  async indexDefinitionPage(url) {
    let tasks = []

    // load definition page in to virtual DOM
    let page = await this.openWeb(url)

    // build definition object
    let def = {
      url: url,
      words: page('#keywords').first().text().replace(/[\n\t ]+/g, ' ').trim().split(': ')[1].split(', '),
      tags: [...this.config.tag],
      videos: page('video source').toArray().map( x => x.attribs.src ).filter(obj => !obj.url.match(/Definition/)),
      body: page('div.definition-panel').toArray().map( panel => {
        let title = page(panel).find('h3.panel-title').text()
        let entries = page(panel).find('div.definition-entry > div').toArray().map(x => x.lastChild.data.trim())
        return `${title}: ${entries.join('; ')}`
      }).join("\n").split("\n").slice(0, 5).join("\n")
    }
    
    // if we have a map of australia, convert that to region tags using the spider config's region map
    page('#states img').toArray().forEach(img => {
      let imgSrc = this.relativeLink(url, `${img.attribs.src}`)
      for (let regionPath in this.config.regions) {
        if (this.relativeLink(url, regionPath) == imgSrc) {
          def.tags = [...def.tags, ...this.config.regions[regionPath]]
        }
      }
    })
    
    // discover links to other sign definition pages, like previous sign, next sign, and the numbered alternate definitions for this keyword
    page("a.btn").toArray().forEach(aLink => {
      tasks.push([ 'definition', this.relativeLink(url, aLink.attribs.href).split('?')[0] ])
    })

    // calculate hash by sorting the def object and hashing it's keys and values in a sorted way
    def.hash = this.hash(Object.keys(def).sort().map(key => `${key}: ${JSON.stringify(def[key])}`).join(','))
    this.content[def.hash] = def

    return { tasks }
  }

  // fetch a video for a specific piece of content
  fetch( url ) {
    return (new Promise((resolve, reject) => {
      let filename = this.tempFile(`${this.hash(url)}.${url.split(/\?#/g)[0].split(/([\/.])/g).slice(-1)[0]}`)
      let req = this.request.get({ url })

      // create timeout mechanism
      let timer = setTimeout(async () => {
        req.abort()
        await fs.unlink(filename)
        reject(`Timeout during video download from media server`)
      }, this.config.timeout * 1000)

      // handle state changes and stream file out to filesystem
      req.on('error', async (...a) => { clearTimeout(timer); await fs.unlink(filename); reject(...a) })
      req.on('end', () => { clearTimeout(timer); resolve(filename) })
      req.pipe(fs.createWriteStream(filename))
    }))
  }
}

module.exports = SignBankSpider