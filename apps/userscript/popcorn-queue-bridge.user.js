// ==UserScript==
// @name         Popcorn Queue Bridge
// @namespace    https://popcorn-queue.local/
// @description  Check PTP slots through Popcorn Queue and send source torrents into the upload service.
// @version      0.1.3
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
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const RESOLUTION_REGEX = /\b(2160p|1080p|1080i|720p|576p|576i|480p|480i|4K|UHD|NTSC|PAL)\b/i;
  const DEFAULT_SERVICE_URL = "http://localhost:3500";
  const DEFAULT_WEB_URL = "http://localhost:5173";
  const CHECK_BATCH_SIZE = 5;
  const API_TIMEOUT_MS = 120000;
  let activeCheckRunId = 0;

  function getSetting(key, fallback) {
    const value = GM_getValue(key);
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function serviceUrl() {
    return DEFAULT_SERVICE_URL.replace(/\/+$/, "");
  }

  function webUrl() {
    return DEFAULT_WEB_URL.replace(/\/+$/, "");
  }

  function browserToken() {
    return String(getSetting("browserToken", ""));
  }

  function registerSettings() {
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
        timeout: API_TIMEOUT_MS,
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

  function torrentReleaseName(torrent) {
    return String((torrent && (torrent.title || torrent.name || torrent.releaseName)) || "");
  }

  function hasUnsupportedFrameRate(name) {
    const text = String(name || "");
    const pattern = /\b(\d+(?:\.\d+)?)\s*f\s*p\s*s\b/gi;
    let match;
    while ((match = pattern.exec(text))) {
      if (Number(match[1]) > 50) return true;
    }
    return false;
  }

  function shouldOfferUpload(torrent, status) {
    return isUploadable(status) && !hasUnsupportedFrameRate(torrentReleaseName(torrent));
  }

  function downloadTorrent(torrent) {
    return apiDownload(absolutize(torrent.downloadUrl), fallbackTorrentFilename(torrent));
  }

  function headerValue(rawHeaders, name) {
    const lowerName = name.toLowerCase();
    return String(rawHeaders || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        return index > 0 ? [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] : null;
      })
      .find((entry) => entry && entry[0] === lowerName)?.[1] || null;
  }

  function decodeFilenameValue(value) {
    const trimmed = String(value || "").trim().replace(/^"(.*)"$/, "$1");
    try {
      return decodeURIComponent(trimmed);
    } catch (_) {
      return trimmed;
    }
  }

  function filenameFromContentDisposition(value) {
    if (!value) return null;
    const extended = value.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i);
    if (extended && extended[1]) return decodeFilenameValue(extended[1]);
    const quoted = value.match(/filename\s*=\s*"([^"]+)"/i);
    if (quoted && quoted[1]) return decodeFilenameValue(quoted[1]);
    const plain = value.match(/filename\s*=\s*([^;]+)/i);
    return plain && plain[1] ? decodeFilenameValue(plain[1]) : null;
  }

  function sanitizeTorrentFilename(filename, fallback) {
    let name = String(filename || fallback || "source.torrent").split(/[\\/]/).pop().trim();
    name = name.replace(/[\0\r\n]/g, "");
    if (!name) name = fallback || "source.torrent";
    return /\.torrent$/i.test(name) ? name : name + ".torrent";
  }

  function fallbackTorrentFilename(torrent) {
    const site = torrent.site || detectSite() || "source";
    const id = torrent.sourceTorrentId || (torrent.downloadUrl && (String(torrent.downloadUrl).match(/[?&]id=(\d+)/) || [])[1]);
    return sanitizeTorrentFilename(id ? site + "-" + id : site + "-source", "source.torrent");
  }

  function apiDownload(url, fallbackFilename) {
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
          else {
            const filename = filenameFromContentDisposition(headerValue(response.responseHeaders, "content-disposition"));
            resolve({
              bytes: response.response,
              filename: sanitizeTorrentFilename(filename, fallbackFilename)
            });
          }
        },
        onerror: () => reject(new Error("Download failed"))
      });
    });
  }

  async function downloadMTeamTorrent(sourceTorrentId, torrent) {
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
        if (tokenResponse.data) return apiDownload(absolutize(tokenResponse.data), fallbackTorrentFilename(torrent || { site: "mteam", sourceTorrentId }));
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

  async function sendJob(torrent, result, button, badge, options = {}) {
    button.textContent = "DL...";
    const sourceTorrent = torrent.sourceTorrentId
      ? await downloadMTeamTorrent(torrent.sourceTorrentId, torrent)
      : await downloadTorrent(torrent);
    button.textContent = "Send...";

    const form = new FormData();
    form.append("torrent", new Blob([sourceTorrent.bytes], { type: "application/x-bittorrent" }), sourceTorrent.filename);
    form.append("candidate", JSON.stringify(stripElement(torrent)));
    form.append("checkResult", JSON.stringify(result));
    const response = await apiRequest("POST", "/api/browser/jobs", form);
    button.textContent = "OK";
    button.style.background = "#30a46c";
    badge.textContent = "QUEUED";
    if (response.job && response.job.id) {
      startJobPolling(response.job.id, button, badge);
      if (options.openQueue !== false) window.open(jobUrl(response.job.id), "_blank");
    }
  }

  function stripElement(torrent) {
    const copy = { ...torrent };
    delete copy.element;
    delete copy.badge;
    delete copy.uploadButton;
    return copy;
  }

  function removeUploadButton(torrent) {
    if (!torrent.uploadButton) return;
    torrent.uploadButton.remove();
    delete torrent.uploadButton;
  }

  function addUploadButton(torrent, result, badge) {
    removeUploadButton(torrent);
    const button = document.createElement("span");
    button.textContent = "Up";
    button.title = "Send to Popcorn Queue\nRight-click: Up without open popcorn queue";
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
    button.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await sendJob(torrent, result, button, badge, { openQueue: false });
      } catch (error) {
        button.textContent = "FAIL";
        button.title = formatError(error);
        button.style.background = "#e5484d";
      }
    });
    badge.after(button);
    torrent.uploadButton = button;
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
    const runId = ++activeCheckRunId;
    const bypassCache = Boolean(options && options.bypassCache);
    if (!browserToken()) {
      setBridgeStatus(status, "Set browser token first", "warn");
      return;
    }
    document.querySelectorAll(".pq-bridge-control").forEach((node) => node.remove());
    const torrents = parseTorrents(site);
    if (!torrents.length) {
      setBridgeStatus(status, "No candidates found on this page", "warn");
      return;
    }
    setBridgeStatus(status, (bypassCache ? "Rechecking " : "Checking ") + torrents.length + " candidates", "loading");
    torrents.forEach((torrent) => {
      const badge = makeBadge("loading", "Queued for Popcorn Queue check");
      torrent.badge = badge;
      torrent.element.after(badge);
    });
    try {
      let completed = 0;
      for (let start = 0; start < torrents.length; start += CHECK_BATCH_SIZE) {
        if (runId !== activeCheckRunId) return;
        const chunk = torrents.slice(start, start + CHECK_BATCH_SIZE);
        setBridgeStatus(status, (bypassCache ? "Rechecking " : "Checking ") + (start + 1) + "-" + (start + chunk.length) + " / " + torrents.length, "loading");
        const payload = { candidates: chunk.map(stripElement), bypassCache };
        const response = await apiRequest("POST", "/api/browser/check/batch", payload);
        if (runId !== activeCheckRunId) return;
        if (!Array.isArray(response.results)) throw new Error("Unexpected API response: missing results");
        response.results.forEach((result, index) => {
          const torrent = chunk[index];
          if (!torrent) return;
          renderCheckResult(site, status, torrent, result);
        });
        completed += chunk.length;
        setBridgeStatus(status, "Checked " + Math.min(completed, torrents.length) + " / " + torrents.length, "loading");
      }
      setBridgeStatus(status, bypassCache ? "Recheck complete" : "Check complete", "ok");
    } catch (error) {
      const message = formatError(error);
      torrents.forEach((torrent) => {
        if (!torrent.badge || torrent.badge.textContent !== "PTP ...") return;
        const badge = makeBadge("error", message);
        torrent.badge.replaceWith(badge);
        torrent.badge = badge;
      });
      setBridgeStatus(status, formatError(error), "error");
    }
  }

  async function recheckTorrent(site, status, torrent) {
    const runId = ++activeCheckRunId;
    if (!browserToken()) {
      setBridgeStatus(status, "Set browser token first", "warn");
      return;
    }
    removeUploadButton(torrent);
    const loadingBadge = makeBadge("loading", "Rechecking through Popcorn Queue");
    torrent.badge.replaceWith(loadingBadge);
    torrent.badge = loadingBadge;
    setBridgeStatus(status, "Rechecking 1 candidate", "loading");
    try {
      const response = await apiRequest("POST", "/api/browser/check", { ...stripElement(torrent), bypassCache: true });
      if (runId !== activeCheckRunId) return;
      if (!response.result) throw new Error("Unexpected API response: missing result");
      renderCheckResult(site, status, torrent, response.result);
      setBridgeStatus(status, "Recheck complete", "ok");
    } catch (error) {
      const message = formatError(error);
      const badge = makeBadge("error", message);
      torrent.badge.replaceWith(badge);
      torrent.badge = badge;
      setBridgeStatus(status, message, "error");
    }
  }

  function renderCheckResult(site, status, torrent, result) {
    const skipHighFrameRate = hasUnsupportedFrameRate(torrentReleaseName(torrent));
    const tooltip = [
      skipHighFrameRate ? "Skipped: release name declares more than 50 fps." : "",
      result.decision.reason,
      result.decision.slotType ? "Slot: " + result.decision.slotType : "",
      result.cache.hit ? "Cache hit: " + (result.cache.cachedAt || "") : "Checked live",
      "Right-click to recheck this page without using the saved cache"
    ].filter(Boolean).join("\n");
    const badge = makeBadge(skipHighFrameRate ? "skip" : result.decision.status, tooltip);
    removeUploadButton(torrent);
    torrent.badge.replaceWith(badge);
    torrent.badge = badge;
    if (result.decision.ptpUrl) {
      badge.style.cursor = "pointer";
      badge.addEventListener("click", () => window.open(result.decision.ptpUrl, "_blank"));
    }
    badge.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      await recheckTorrent(site, status, torrent);
    });
    if (shouldOfferUpload(torrent, result.decision.status)) addUploadButton(torrent, result, badge);
  }

  registerSettings();
  const site = detectSite();
  if (site !== "unknown") installControls(site);
})();
