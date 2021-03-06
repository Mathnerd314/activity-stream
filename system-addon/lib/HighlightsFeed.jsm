/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const {actionTypes: at} = Cu.import("resource://activity-stream/common/Actions.jsm", {});

const {shortURL} = Cu.import("resource://activity-stream/lib/ShortURL.jsm", {});
const {SectionsManager} = Cu.import("resource://activity-stream/lib/SectionsManager.jsm", {});
const {TOP_SITES_SHOWMORE_LENGTH} = Cu.import("resource://activity-stream/common/Reducers.jsm", {});
const {Dedupe} = Cu.import("resource://activity-stream/common/Dedupe.jsm", {});

XPCOMUtils.defineLazyModuleGetter(this, "filterAdult",
  "resource://activity-stream/lib/FilterAdult.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "NewTabUtils",
  "resource://gre/modules/NewTabUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Screenshots",
  "resource://activity-stream/lib/Screenshots.jsm");

const HIGHLIGHTS_MAX_LENGTH = 9;
const HIGHLIGHTS_UPDATE_TIME = 15 * 60 * 1000; // 15 minutes
const MANY_EXTRA_LENGTH = HIGHLIGHTS_MAX_LENGTH * 5 + TOP_SITES_SHOWMORE_LENGTH;
const SECTION_ID = "highlights";

this.HighlightsFeed = class HighlightsFeed {
  constructor() {
    this.highlightsLastUpdated = 0;
    this.highlights = [];
    this.dedupe = new Dedupe(this._dedupeKey);
  }

  _dedupeKey(site) {
    return site && site.url;
  }

  init() {
    SectionsManager.onceInitialized(this.postInit.bind(this));
  }

  postInit() {
    SectionsManager.enableSection(SECTION_ID);
    this.fetchHighlights(true);
  }

  uninit() {
    SectionsManager.disableSection(SECTION_ID);
  }

  async fetchHighlights(broadcast = false) {
    // We need TopSites to have been initialised for deduping
    if (!this.store.getState().TopSites.initialized) {
      await new Promise(resolve => {
        const unsubscribe = this.store.subscribe(() => {
          if (this.store.getState().TopSites.initialized) {
            unsubscribe();
            resolve();
          }
        });
      });
    }

    // Request more than the expected length to allow for items being removed by
    // deduping against Top Sites or multiple history from the same domain, etc.
    const manyPages = await NewTabUtils.activityStreamLinks.getHighlights({numItems: MANY_EXTRA_LENGTH});

    // Remove adult highlights if we need to
    const checkedAdult = this.store.getState().Prefs.values.filterAdult ?
      filterAdult(manyPages) : manyPages;

    // Remove any Highlights that are in Top Sites already
    const [, deduped] = this.dedupe.group(this.store.getState().TopSites.rows, checkedAdult);

    // Store existing images in case we need to reuse them
    const currentImages = {};
    for (const site of this.highlights) {
      if (site && site.image) {
        currentImages[site.url] = site.image;
      }
    }

    // Keep all "bookmark"s and at most one (most recent) "history" per host
    this.highlights = [];
    const hosts = new Set();
    for (const page of deduped) {
      const hostname = shortURL(page);
      // Skip this history page if we already something from the same host
      if (page.type === "history" && hosts.has(hostname)) {
        continue;
      }

      // If we already have the image for the card, use that immediately. Else
      // asynchronously fetch the image.
      const image = currentImages[page.url];
      if (!image) {
        this.fetchImage(page.url, page.preview_image_url);
      }

      // We want the page, so update various fields for UI
      Object.assign(page, {
        image,
        hasImage: true, // We always have an image - fall back to a screenshot
        hostname,
        type: page.bookmarkGuid ? "bookmark" : page.type
      });

      // Add the "bookmark" or not-skipped "history"
      this.highlights.push(page);
      hosts.add(hostname);

      // Skip the rest if we have enough items
      if (this.highlights.length === HIGHLIGHTS_MAX_LENGTH) {
        break;
      }
    }

    SectionsManager.updateSection(SECTION_ID, {rows: this.highlights}, this.highlightsLastUpdated === 0 || broadcast);
    this.highlightsLastUpdated = Date.now();
  }

  /**
   * Fetch an image for a given highlight and update the card with it. If no
   * image is available then fallback to fetching a screenshot. Update the card
   * in `this.highlights` so that the image is cached for the next refresh.
   */
  async fetchImage(url, imageUrl) {
    const image = await Screenshots.getScreenshotForURL(imageUrl || url);
    SectionsManager.updateSectionCard(SECTION_ID, url, {image}, true);
    if (image) {
      const highlight = this.highlights.find(site => site.url === url);
      if (highlight) {
        highlight.image = image;
      }
    }
  }

  onAction(action) {
    switch (action.type) {
      case at.INIT:
        this.init();
        break;
      case at.NEW_TAB_LOAD:
        if (this.highlights.length < HIGHLIGHTS_MAX_LENGTH) {
          // If we haven't filled the highlights grid yet, fetch again.
          this.fetchHighlights(true);
        } else if (Date.now() - this.highlightsLastUpdated >= HIGHLIGHTS_UPDATE_TIME) {
          // If the last time we refreshed the data is greater than 15 minutes, fetch again.
          this.fetchHighlights(false);
        }
        break;
      case at.MIGRATION_COMPLETED:
      case at.PLACES_HISTORY_CLEARED:
      case at.PLACES_LINK_DELETED:
      case at.PLACES_LINK_BLOCKED:
        this.fetchHighlights(true);
        break;
      case at.PLACES_BOOKMARK_ADDED:
      case at.PLACES_BOOKMARK_REMOVED:
      case at.TOP_SITES_UPDATED:
        this.fetchHighlights(false);
        break;
      case at.UNINIT:
        this.uninit();
        break;
    }
  }
};

this.HIGHLIGHTS_UPDATE_TIME = HIGHLIGHTS_UPDATE_TIME;
this.EXPORTED_SYMBOLS = ["HighlightsFeed", "HIGHLIGHTS_UPDATE_TIME", "SECTION_ID"];
