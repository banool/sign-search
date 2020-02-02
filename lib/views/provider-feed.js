// Feed Provider generates a feed of recently added content, to add to the homepage, or to the discovery feeds
const html = require('nanohtml')
const fs = require('fs-extra')
const cbor = require('borc')

const Feed = require('feed').Feed
const dateFNS = require('date-fns')

const appRootPath = require('app-root-path')
const signSearchConfig = appRootPath.require('/package.json').signSearch
const spiderConfigs = appRootPath.require('/tools/spiders/configs.json')
const base = require('./provider-base')

class FeedProvider extends base {
  async load() {
    if (this.visibleUpdates) return
    let updates = cbor.decodeAll(await fs.readFile(appRootPath.resolve('/datasets/update-log.cbor')))
    this.visibleUpdates = updates.slice(-(signSearchConfig.discoveryFeed.length))
  }

  getPageType() {
    return "home"
  }

  // add's data attributes telling the front end UI to hook up search box and stuff
  // TODO: get rid of this, lets just always have the search box
  getData() {
    return { hook: "true" }
  }


  toFeeds() {
    let feed = new Feed(signSearchConfig.discoveryFeed)

    this.visibleUpdates.forEach(entry => {
      let spiderConfig = {
        displayName: entry.provider,
        link: entry.providerLink,
        ... (spiderConfigs[entry.provider] || {})
      }
      feed.addItem({
        id: `${entry.provider}:${entry.id}`,
        title: `${spiderConfig.displayName} ${entry.verb} ${[...entry.words].flat(2).join(', ').trim()}`,
        link: entry.link,
        date: new Date(entry.timestamp),
        description: `${entry.body}\n...`,
        author: { name: spiderConfig.displayName, link: spiderConfig.link },
      })
    })

    return {
      "discovery.rss": feed.rss2(),
      "discovery.atom": feed.atom1(),
      "discovery.json": feed.json1()
    }
  }

  toHTML() {
    let elements = []
    let lastDate = ''
    this.visibleUpdates.forEach(entry => {
      let timestamp = new Date(entry.timestamp)
      let thisDate = dateFNS.format(timestamp, "EEEE, do LLLL yyyy")
      if (lastDate != thisDate) {
        lastDate = thisDate
        elements.push(html`<h2><time datetime="${dateFNS.format(timestamp, "yyyy-MM-dd")}">${thisDate}</time></h2>`)
      }

      let providerName = (spiderConfigs[entry.provider] || { displayName: entry.provider }).displayName
      let providerURL = (spiderConfigs[entry.provider] || { link: entry.providerLink }).link
      let providerLink = html`<a href="${providerURL}">${providerName}</a>`
      let verb = entry.verb || 'documented'
      let entryLink = html`<a href="${entry.link}">${[...entry.words].flat(2).slice(0,3).join(', ').trim()}</a>`
      elements.push(html`<div class="discovery-link">${providerLink} ${verb} ${entryLink}</div>`)
    })

  return html`<main><div id="recently-added-list" class="inset-box">${elements}</div></main>`
  }
}

module.exports = FeedProvider