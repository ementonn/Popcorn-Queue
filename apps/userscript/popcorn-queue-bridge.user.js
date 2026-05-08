// ==UserScript==
// @name         Popcorn Queue Bridge
// @namespace    https://popcorn-queue.local/
// @description  Check PTP slots through Popcorn Queue and send source torrents into the upload service.
// @version      0.1.0
// @author       emt
// @match        https://tjupt.org/torrents.php*
// @match        https://pterclub.net/torrents.php*
// @match        https://kp.m-team.cc/browse*
// @match        https://kp.m-team.cc/torrents*
// @match        https://hdbits.org/browse*
// @match        https://hdbits.org/torrents.php*
// @match        https://hhanclub.net/torrents.php*
// @match        https://hhan.club/torrents.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      example.com
// @connect      tjupt.org
// @connect      pterclub.net
// @connect      hdbits.org
// @connect      hhanclub.net
// @connect      hhan.club
// @connect      api.m-team.cc
// @connect      api.m-team.io
// @connect      kp.m-team.cc
// @connect      *.m-team.cc
// @connect      *.m-team.io
// ==/UserScript==

(function () {
  "use strict";

  const RESOLUTION_REGEX = /\b(2160p|1080p|1080i|720p|576p|576i|480p|480i|4K|UHD|NTSC|PAL)\b/i;
  const DEFAULT_SERVICE_URL = "http://localhost:3500";
  const DEFAULT_WEB_URL = "http://localhost:5173";

  function getSetting(key, fallback) {
    const value = GM_getValue(key);
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function serviceUrl() {
    return String(getSetting("serviceUrl", DEFAULT_SERVICE_URL)).replace(/\/+$/, "");
  }

  function webUrl() {
    return String(getSetting("webUrl", DEFAULT_WEB_URL)).replace(/\/+$/, "");
  }

  function browserToken() {
    return String(getSetting("browserToken", ""));
  }

  function registerSettings() {
    GM_registerMenuCommand("Set Popcorn Queue API URL", () => {
      const current = serviceUrl();
      const next = prompt("Popcorn Queue API URL", current);
      if (next) GM_setValue("serviceUrl", next.replace(/\/+$/, ""));
    });
    GM_registerMenuCommand("Set Popcorn Queue Web URL", () => {
      const current = webUrl();
      const next = prompt("Popcorn Queue web URL", current);
      if (next) GM_setValue("webUrl", next.replace(/\/+$/, ""));
    });
    GM_registerMenuCommand("Set Browser Token", () => {
      const next = prompt("Popcorn Queue browser token", browserToken());
      if (next !== null) GM_setValue("browserToken", next);
    });
  }

  function apiRequest(method, path, payload, responseType) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: serviceUrl() + path,
        data: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined,
        responseType,
        headers: payload instanceof FormData ? { Authorization: "Bearer " + browserToken() } : {
          Authorization: "Bearer " + browserToken(),
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(apiErrorMessage(response, method, path)));
            return;
          }
          if (responseType === "arraybuffer") {
            resolve(response.response);
            return;
          }
          try {
            resolve(JSON.parse(response.responseText || "{}"));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("Request failed: " + path)),
        ontimeout: () => reject(new Error("Request timed out: " + path))
      });
    });
  }

  function apiErrorMessage(response, method, path) {
    const prefix = method + " " + path + " failed with HTTP " + response.status;
    const text = String(response.responseText || "").trim();
    if (!text) return prefix;
    try {
      const parsed = JSON.parse(text);
      const detail = parsed.message || parsed.error || parsed.detail;
      if (detail) return prefix + ": " + detail;
    } catch (_) {
      // Plain-text API/proxy responses are surfaced below.
    }
    return prefix + ": " + text.slice(0, 240);
  }

  function formatError(error) {
    if (error instanceof Error && error.message) return error.message;
    return String(error || "Unknown error");
  }

  function extractImdbId(value) {
    if (!value) return null;
    const match = String(value).match(/tt(\d{7,})/i);
    return match ? "tt" + match[1] : null;
  }

  function detectSite() {
    const host = window.location.hostname;
    if (host.includes("tjupt.org")) return "tjupt";
    if (host.includes("pterclub.net")) return "pter";
    if (host.includes("m-team")) return "mteam";
    if (host.includes("hdbits.org")) return "hdb";
    if (host.includes("hhanclub.net") || host.includes("hhan.club")) return "hhclub";
    return "unknown";
  }

  function absolutize(url) {
    if (!url) return null;
    return /^https?:\/\//i.test(url) ? url : new URL(url, window.location.origin).href;
  }

  function parseTJUPT(site) {
    const rows = document.querySelectorAll("table.torrents > tbody > tr");
    const torrents = [];
    rows.forEach((row) => {
      const nameTable = row.querySelector("table.torrentname");
      const link = nameTable && nameTable.querySelector('a[href*="details.php"]');
      if (!link) return;
      const title = link.getAttribute("title") || link.textContent.trim();
      const imdbLink = nameTable.querySelector('a[href*="imdb.com/title/tt"]');
      const dlLink = row.querySelector('a[href*="download.php?id="]');
      torrents.push({
        site,
        title,
        imdbId: imdbLink ? extractImdbId(imdbLink.href) : null,
        resolution: (title.match(RESOLUTION_REGEX) || [])[1] || null,
        sourceUrl: link.href,
        downloadUrl: dlLink ? dlLink.href : null,
        element: link
      });
    });
    return torrents;
  }

  function parsePTer(site) {
    const rows = document.querySelectorAll("table.torrents > tbody > tr, table#torrenttable > tbody > tr");
    const torrents = [];
    rows.forEach((row) => {
      const nameTable = row.querySelector("table.torrentname");
      const link = nameTable && nameTable.querySelector('a[href*="details.php"]');
      if (!link) return;
      const title = link.getAttribute("title") || link.textContent.trim();
      const imdbNode = nameTable.querySelector("[data-imdbid]");
      const rawImdb = imdbNode && imdbNode.getAttribute("data-imdbid");
      const dlLink = row.querySelector('a[href*="download.php?id="]');
      torrents.push({
        site,
        title,
        imdbId: extractImdbId(rawImdb) || (rawImdb && /^\d+$/.test(rawImdb) ? "tt" + rawImdb : null),
        resolution: (title.match(RESOLUTION_REGEX) || [])[1] || null,
        sourceUrl: link.href,
        downloadUrl: dlLink ? dlLink.href : null,
        element: link
      });
    });
    return torrents;
  }

  function parseMTeam(site) {
    const rows = document.querySelectorAll("table.w-full.table-fixed tr");
    const torrents = [];
    rows.forEach((row) => {
      const link = row.querySelector('a[href*="/detail/"]');
      if (!link) return;
      const strong = link.querySelector("strong");
      const title = strong ? strong.textContent.trim() : link.textContent.trim();
      let imdbId = null;
      row.querySelectorAll('a[href*="imdb"]').forEach((a) => {
        imdbId = imdbId || extractImdbId(decodeURIComponent(a.href));
      });
      const idMatch = link.href.match(/\/detail\/(\d+)/);
      torrents.push({
        site,
        title,
        imdbId,
        resolution: (title.match(RESOLUTION_REGEX) || [])[1] || null,
        sourceUrl: link.href,
        downloadUrl: null,
        sourceTorrentId: idMatch ? idMatch[1] : null,
        element: link
      });
    });
    return torrents;
  }

  function parseHDB(site) {
    const torrents = [];
    document.querySelectorAll("tr").forEach((row) => {
      if (!row.querySelector("td.catcell")) return;
      const link = row.querySelector('a[href*="details.php?id="]');
      if (!link) return;
      const title = link.textContent.trim();
      let imdbId = null;
      const imdbLink = row.querySelector("a[data-imdb-link]");
      if (imdbLink) imdbId = extractImdbId(imdbLink.getAttribute("data-imdb-link"));
      if (!imdbId) {
        const wishlistLink = row.querySelector('a[onclick*="addWishlist"]');
        if (wishlistLink) imdbId = extractImdbId(wishlistLink.getAttribute("onclick"));
      }
      const dlLink = row.querySelector('a[href*="download.php"]');
      torrents.push({
        site,
        title,
        imdbId,
        resolution: (title.match(RESOLUTION_REGEX) || [])[1] || null,
        sourceUrl: link.href,
        downloadUrl: dlLink ? dlLink.href : null,
        element: link
      });
    });
    return torrents;
  }

  function parseHHClub(site) {
    const torrents = [];
    document.querySelectorAll(".torrent-table-for-spider .torrent-table-sub-info").forEach((row) => {
      const link = row.querySelector('a.torrent-info-text-name[href*="details.php?id="]');
      if (!link) return;
      const title = link.textContent.trim();
      const imdbLink = row.querySelector('a[href*="imdb.com/title/tt"], a[href*="imdb"]');
      const dlLink = row.querySelector('.torrent-manage a[href*="download.php?id="], a[href*="download.php?id="]');
      torrents.push({
        site,
        title,
        imdbId: imdbLink ? extractImdbId(decodeURIComponent(imdbLink.href)) : null,
        resolution: (title.match(RESOLUTION_REGEX) || [])[1] || null,
        sourceUrl: link.href,
        downloadUrl: dlLink ? dlLink.href : null,
        element: link
      });
    });
    return torrents;
  }

  function parseTorrents(site) {
    if (site === "tjupt") return parseTJUPT(site);
    if (site === "pter") return parsePTer(site);
    if (site === "mteam") return parseMTeam(site);
    if (site === "hdb") return parseHDB(site);
    if (site === "hhclub") return parseHHClub(site);
    return [];
  }

  function makeBadge(status, tooltip) {
    const styles = {
      full: ["PTP FULL", "#e5484d"],
      blocked: ["PTP FULL", "#e5484d"],
      trumpable: ["PTP TRUMP", "#f76b15"],
      coexist: ["PTP COEXIST", "#8e4ec6"],
      open: ["PTP OPEN", "#30a46c"],
      no_torrents: ["PTP OPEN", "#30a46c"],
      not_found: ["PTP NEW", "#30a46c"],
      review: ["PTP REVIEW", "#f5a524"],
      skip: ["SKIP", "#8b8d98"],
      error: ["PTP ?", "#6f6e77"],
      loading: ["PTP ...", "#6f6e77"]
    };
    const [text, color] = styles[status] || styles.error;
    const span = document.createElement("span");
    span.textContent = text;
    span.title = tooltip || "";
    span.className = "pq-bridge-control pq-bridge-badge";
    span.style.cssText = "display:inline-block;margin-left:5px;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:bold;cursor:help;vertical-align:middle;color:#fff;background:" + color;
    return span;
  }

  function isUploadable(status) {
    return ["not_found", "open", "no_torrents", "trumpable", "coexist", "review"].includes(status);
  }

  function downloadTorrent(url) {
    return apiDownload(absolutize(url));
  }

  function apiDownload(url) {
    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error("No download URL"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        headers: { Accept: "application/x-bittorrent,application/octet-stream,*/*" },
        onload: (response) => {
          if (response.status !== 200) reject(new Error("Download failed: HTTP " + response.status));
          else resolve(response.response);
        },
        onerror: () => reject(new Error("Download failed"))
      });
    });
  }

  async function downloadMTeamTorrent(sourceTorrentId) {
    const auth = localStorage.getItem("auth") || "";
    const body = new URLSearchParams({ id: String(sourceTorrentId) }).toString();
    const hosts = ["api.m-team.io", "api.m-team.cc"];
    let lastError = null;
    for (const host of hosts) {
      if (!auth) break;
      try {
        const tokenResponse = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: "POST",
            url: "https://" + host + "/api/torrent/genDlToken",
            data: body,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              Accept: "application/json",
              ts: String(Math.floor(Date.now() / 1000)),
              authorization: auth
            },
            onload: (response) => {
              if (response.status !== 200) reject(new Error("HTTP " + response.status));
              else resolve(JSON.parse(response.responseText));
            },
            onerror: () => reject(new Error("token request failed"))
          });
        });
        if (tokenResponse.data) return apiDownload(absolutize(tokenResponse.data));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("M-Team session token unavailable");
  }

  function jobUrl(jobId) {
    return webUrl() + "/jobs/" + encodeURIComponent(jobId);
  }

  function linkBadgeToJob(badge, jobId) {
    const linked = badge.cloneNode(true);
    linked.title = "Open Popcorn Queue job " + jobId;
    linked.style.cursor = "pointer";
    linked.addEventListener("click", () => window.open(jobUrl(jobId), "_blank"));
    badge.replaceWith(linked);
    return linked;
  }

  function startJobPolling(jobId, button, badge) {
    const jobBadge = linkBadgeToJob(badge, jobId);
    let remaining = 45;
    const update = async () => {
      try {
        const response = await apiRequest("GET", "/api/jobs/" + encodeURIComponent(jobId));
        const job = response.job;
        if (!job) return;
        const state = String(job.state || "queued").toUpperCase();
        jobBadge.textContent = "JOB " + state;
        jobBadge.title = [
          "Popcorn Queue job " + job.id,
          "State: " + job.state,
          "Phase: " + job.phase,
          "Click to open job"
        ].filter(Boolean).join("\n");
        button.textContent = job.state === "done" ? "Done" : job.phase || "Job";
        if (job.state === "failed") button.style.background = "#e5484d";
        if (job.state === "done") button.style.background = "#30a46c";
        if (job.state === "failed" || job.state === "done") return true;
      } catch (error) {
        button.title = formatError(error);
      }
      return false;
    };
    void update();
    const interval = window.setInterval(async () => {
      remaining -= 1;
      const finished = await update();
      if (finished || remaining <= 0) window.clearInterval(interval);
    }, 4000);
  }

  async function sendJob(torrent, result, button, badge) {
    button.textContent = "DL...";
    const torrentData = torrent.sourceTorrentId
      ? await downloadMTeamTorrent(torrent.sourceTorrentId)
      : await downloadTorrent(torrent.downloadUrl);
    button.textContent = "Send...";

    const form = new FormData();
    form.append("torrent", new Blob([torrentData], { type: "application/x-bittorrent" }), (torrent.sourceTorrentId || "source") + ".torrent");
    form.append("candidate", JSON.stringify(stripElement(torrent)));
    form.append("checkResult", JSON.stringify(result));
    const response = await apiRequest("POST", "/api/browser/jobs", form);
    button.textContent = "OK";
    button.style.background = "#30a46c";
    badge.textContent = "QUEUED";
    if (response.job && response.job.id) {
      startJobPolling(response.job.id, button, badge);
      window.open(jobUrl(response.job.id), "_blank");
    }
  }

  function stripElement(torrent) {
    const copy = { ...torrent };
    delete copy.element;
    delete copy.badge;
    return copy;
  }

  function addUploadButton(torrent, result, badge) {
    const button = document.createElement("span");
    button.textContent = "Up";
    button.title = "Send to Popcorn Queue";
    button.className = "pq-bridge-control pq-bridge-upload";
    button.style.cssText = "display:inline-block;margin-left:3px;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:bold;cursor:pointer;vertical-align:middle;background:#1c6bba;color:#fff;";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await sendJob(torrent, result, button, badge);
      } catch (error) {
        button.textContent = "FAIL";
        button.title = formatError(error);
        button.style.background = "#e5484d";
      }
    });
    badge.after(button);
  }

  function setBridgeStatus(status, text, tone) {
    status.textContent = text;
    const colors = {
      neutral: "#c9d1d9",
      ok: "#7ce38b",
      warn: "#f5c36a",
      error: "#ff8b8b",
      loading: "#a5d6ff"
    };
    status.style.color = colors[tone || "neutral"] || colors.neutral;
    status.title = text;
  }

  function installControls(site) {
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:99999;padding:8px 10px;border-radius:6px;background:#1f2328;color:#fff;font:12px Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);";
    const button = document.createElement("button");
    button.textContent = "Check PTP";
    button.style.cssText = "margin-right:8px;padding:4px 8px;border:0;border-radius:4px;background:#1c6bba;color:#fff;cursor:pointer;";
    const recheckButton = document.createElement("button");
    recheckButton.textContent = "Recheck";
    recheckButton.title = "Bypass the saved PTP cache for this page";
    recheckButton.style.cssText = "margin-right:8px;padding:4px 8px;border:0;border-radius:4px;background:#444c56;color:#fff;cursor:pointer;";
    const status = document.createElement("span");
    setBridgeStatus(status, site, "neutral");
    button.addEventListener("click", () => runCheck(site, status));
    recheckButton.addEventListener("click", () => runCheck(site, status, { bypassCache: true }));
    bar.append(button, recheckButton, status);
    document.body.appendChild(bar);
  }

  async function runCheck(site, status, options) {
    const bypassCache = Boolean(options && options.bypassCache);
    if (!browserToken()) {
      setBridgeStatus(status, "Set browser token first", "warn");
      return;
    }
    document.querySelectorAll(".pq-bridge-control").forEach((node) => node.remove());
    const torrents = parseTorrents(site);
    setBridgeStatus(status, (bypassCache ? "Rechecking " : "Checking ") + torrents.length + " candidates", "loading");
    torrents.forEach((torrent) => {
      const badge = makeBadge("loading", "Queued for Popcorn Queue check");
      torrent.badge = badge;
      torrent.element.after(badge);
    });
    try {
      const payload = { candidates: torrents.map(stripElement), bypassCache };
      const response = await apiRequest("POST", "/api/browser/check/batch", payload);
      response.results.forEach((result, index) => {
        const torrent = torrents[index];
        if (!torrent) return;
        const tooltip = [
          result.decision.reason,
          result.decision.slotType ? "Slot: " + result.decision.slotType : "",
          result.cache.hit ? "Cache hit: " + (result.cache.cachedAt || "") : "Checked live",
          "Right-click to recheck this page without using the saved cache"
        ].filter(Boolean).join("\n");
        const badge = makeBadge(result.decision.status, tooltip);
        torrent.badge.replaceWith(badge);
        torrent.badge = badge;
        if (result.decision.ptpUrl) {
          badge.style.cursor = "pointer";
          badge.addEventListener("click", () => window.open(result.decision.ptpUrl, "_blank"));
        }
        badge.addEventListener("contextmenu", async (event) => {
          event.preventDefault();
          await runCheck(site, status, { bypassCache: true });
        });
        if (isUploadable(result.decision.status)) addUploadButton(torrent, result, badge);
      });
      setBridgeStatus(status, bypassCache ? "Recheck complete" : "Check complete", "ok");
    } catch (error) {
      setBridgeStatus(status, formatError(error), "error");
    }
  }

  registerSettings();
  const site = detectSite();
  if (site !== "unknown") installControls(site);
})();
