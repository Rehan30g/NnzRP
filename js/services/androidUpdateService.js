/* js/services/androidUpdateService.js - Android-only in-app APK updater.
   ====================================================================
   The web content of this app never needs updating: the APK is a thin
   Capacitor WebView shell pointed at the live GitHub Pages deploy
   (capacitor.config.json's `server.url`), so a `git push` reaches every
   installed phone on its next launch. The NATIVE shell is the one thing that
   cannot self-update that way - a new plugin, a new permission or a new
   Capacitor version genuinely needs a freshly built, freshly installed APK.
   This module is that path: check -> download -> hand to Android's own
   package installer.

   HARD PLATFORM CONSTRAINT (do not try to "fix" this): a sideloaded,
   non-Play-Store app can NEVER install an APK with zero user interaction.
   REQUEST_INSTALL_PACKAGES (declared in AndroidManifest.xml) only makes this
   app a *legitimate install source*; Android still shows its own
   confirmation dialog and the user still taps "Install" exactly once. The
   only ways around that are MDM/device-owner provisioning, which this app is
   not and should not become. So "auto update" here means everything except
   that single unavoidable tap is automatic.

   Capacitor plugins are read off `window.Capacitor.Plugins` at call time and
   NEVER imported as npm packages - this app has no bundler and loads every
   file as a plain relative-import ES module straight in the browser, so a
   bare `import '@capawesome-team/capacitor-file-opener'` specifier could
   never resolve. Same access pattern as js/utils/nativeExport.js and
   js/app.js's @capacitor/app usage; the packages are devDependencies purely
   so `npx cap sync android` registers them natively.
   ==================================================================== */

/** Fallbacks used when version.json omits a field (or is an older copy of the
 *  file cached by a service worker that predates the field). */
export const DEFAULT_RELEASE_URL = 'https://github.com/Rehan30g/NnzRP/releases/tag/latest';
export const DEFAULT_APK_DOWNLOAD_URL = 'https://github.com/Rehan30g/NnzRP/releases/download/latest/app-release.apk';

/** Filename the downloaded APK is written under inside the app's own cache
 *  dir. Deliberately fixed rather than timestamped so repeated checks
 *  overwrite one file instead of slowly filling the cache with 3MB+ copies. */
const UPDATE_APK_FILENAME = 'nnzrp-update.apk';

const APK_MIME_TYPE = 'application/vnd.android.package-archive';

/** True only inside the installed Android APK. Electron, a plain browser tab
 *  and the installed PWA all return false (no Capacitor bridge is injected
 *  there), which is what keeps this whole module inert off-Android. */
export function isAndroidNative() {
  return !!window.Capacitor?.isNativePlatform?.();
}

/**
 * Reads the running APK's own version and the published one, and reports
 * whether they differ.
 *
 * `currentVersion` is @capacitor/app's getInfo().version, i.e. exactly
 * `android/app/build.gradle`'s versionName. `latestVersion` is
 * `version.json`'s `latestApkVersion` at the site root - a MANUAL bump (see
 * CLAUDE.md); nothing keeps it in sync with build.gradle automatically.
 *
 * The comparison is a plain inequality, not semver ordering, on purpose: the
 * two values are hand-kept in step, and "different from the released build"
 * is the question actually being asked (a phone left on a build that was
 * later pulled should still be told to move).
 *
 * @param {{timeoutMs?: number}} [options] - `timeoutMs` caps the whole check
 *        and REJECTS when it elapses (boot uses this so a dead network can
 *        never hold the splash screen; the Settings button passes none).
 * @returns {Promise<{available: boolean, currentVersion: string, latestVersion: string, releaseUrl: string, downloadUrl: string}>}
 */
export async function checkForUpdate({ timeoutMs = 0 } = {}) {
  const AppPlugin = window.Capacitor?.Plugins?.App;
  if (!isAndroidNative() || !AppPlugin) {
    throw new Error('App updates are only available in the installed Android app.');
  }

  const work = (async () => {
    const [info, res] = await Promise.all([
      AppPlugin.getInfo(),
      // Relative to the deployed site root (the APK's server.url), and
      // no-store so a stale service-worker/HTTP cache entry can't hide a
      // freshly published version.
      fetch('version.json', { cache: 'no-store' })
    ]);
    if (!res.ok) throw new Error(`Could not read version.json (HTTP ${res.status}).`);
    const remote = await res.json();

    const currentVersion = info?.version || '';
    const latestVersion = remote?.latestApkVersion || '';
    return {
      available: !!latestVersion && latestVersion !== currentVersion,
      currentVersion,
      latestVersion,
      releaseUrl: remote?.releaseUrl || DEFAULT_RELEASE_URL,
      downloadUrl: remote?.apkDownloadUrl || DEFAULT_APK_DOWNLOAD_URL
    };
  })();

  if (!timeoutMs) return work;
  return Promise.race([
    work,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Update check timed out.')), timeoutMs)
    )
  ]);
}

/* Chunk size for arrayBufferToBase64 below. Two constraints decide it:
   - small enough that String.fromCharCode.apply() never exceeds the JS
     engine's max-arguments-per-call limit (~65k in V8, and it throws/
     misbehaves well before that on some builds);
   - an exact multiple of 3, so each chunk encodes to a whole number of
     base64 quartets with NO padding. That is what makes concatenating the
     per-chunk btoa() outputs identical to btoa()-ing the whole buffer at
     once. Change this and you must keep it divisible by 3. */
const BASE64_CHUNK_BYTES = 32256; // 32256 / 3 === 10752

/**
 * ArrayBuffer -> base64, in chunks.
 *
 * The naive `btoa(String.fromCharCode(...new Uint8Array(buffer)))` blows the
 * max-arguments-per-call limit on anything multi-megabyte (an APK is several)
 * and fails with a RangeError - or, worse, silently on some engines. This
 * walks the bytes in fixed-size, 3-byte-aligned windows instead.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string} base64, byte-identical to encoding the whole buffer at once.
 */
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    let binary = '';
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
    parts.push(btoa(binary));
  }
  return parts.join('');
}

/**
 * Downloads the APK into the app's own cache dir and opens Android's package
 * installer on it. Resolves as soon as the installer intent has been fired -
 * from that point the OS dialog owns the flow and the caller has nothing
 * left to do but stop showing a spinner.
 *
 * Two download strategies, in order:
 *
 *  1. `Filesystem.downloadFile()` - a NATIVE HTTP download straight to disk.
 *     This is the primary path specifically because it is not subject to
 *     CORS: GitHub's release-asset endpoint sends no
 *     Access-Control-Allow-Origin header (verified against the live URL), so
 *     a plain `fetch()` from the page's https://rehan30g.github.io origin
 *     would be blocked by the WebView before a single byte arrived. It also
 *     never materialises the whole APK in JS memory, and gives real progress
 *     events. (The method is marked deprecated in @capacitor/filesystem 8 in
 *     favour of a separate @capacitor/file-transfer plugin, but is still
 *     fully implemented natively - swapping to that plugin later is a
 *     drop-in change confined to this function.)
 *  2. `fetch()` + arrayBufferToBase64() + `Filesystem.writeFile()` - used
 *     only if (1) is missing or fails. Works for any mirror that does send
 *     CORS headers, and keeps this function useful if downloadFile is
 *     eventually removed.
 *
 * @param {string} downloadUrl - direct .apk URL (version.json's apkDownloadUrl).
 * @param {(p: {loaded: number, total: number, percent: number|null}) => void} [onProgress]
 * @returns {Promise<string>} the on-device path the APK was written to.
 */
export async function downloadAndInstall(downloadUrl, onProgress) {
  const plugins = window.Capacitor?.Plugins;
  if (!isAndroidNative() || !plugins?.Filesystem) {
    throw new Error('App updates are only available in the installed Android app.');
  }
  if (!plugins.FileOpener) {
    throw new Error('The file-opener plugin is missing from this build - reinstall the latest APK manually.');
  }

  const url = downloadUrl || DEFAULT_APK_DOWNLOAD_URL;
  const report = (loaded, total) => {
    if (typeof onProgress !== 'function') return;
    onProgress({ loaded, total, percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null });
  };

  let path = null;
  let nativeError = null;

  if (typeof plugins.Filesystem.downloadFile === 'function') {
    let progressHandle = null;
    try {
      // addListener is async in Capacitor 6+ (returns a Promise of the
      // handle); awaiting it before starting the download means no early
      // chunk event is missed.
      if (typeof plugins.Filesystem.addListener === 'function') {
        progressHandle = await plugins.Filesystem.addListener('progress', (ev) => {
          report(ev?.bytes || 0, ev?.contentLength || 0);
        });
      }
      const res = await plugins.Filesystem.downloadFile({
        url,
        path: UPDATE_APK_FILENAME,
        directory: 'CACHE',
        progress: true
      });
      path = res?.path || null;
    } catch (err) {
      nativeError = err;
    } finally {
      try { await progressHandle?.remove?.(); } catch { /* listener already gone */ }
    }
  }

  if (!path) {
    // Fallback: pull it through the WebView instead. Subject to CORS (see
    // the function comment) - if the native path above failed for a network
    // reason this will usually fail too, but its error message is the more
    // useful one to surface.
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      const total = Number(res.headers.get('content-length')) || 0;
      const buffer = await res.arrayBuffer();
      report(buffer.byteLength, total || buffer.byteLength);

      const written = await plugins.Filesystem.writeFile({
        path: UPDATE_APK_FILENAME,
        data: arrayBufferToBase64(buffer),
        directory: 'CACHE'
        // No `encoding` - omitting it is what tells the Filesystem plugin the
        // string is base64 to be written back as raw bytes, rather than utf8
        // text (which would corrupt the APK).
      });
      path = written?.uri || null;
    } catch (err) {
      throw new Error(nativeError?.message ? `${nativeError.message} (${err.message})` : err.message);
    }
  }

  if (!path) throw new Error(nativeError?.message || 'The update could not be saved to this device.');

  // ACTION_VIEW on the file with the APK mime type is what routes it to
  // Android's Package Installer. The plugin resolves the plain cache path
  // through this app's existing FileProvider (authority
  // "${applicationId}.fileprovider", already declared in AndroidManifest.xml
  // with <cache-path path="." /> in res/xml/file_paths.xml) into the
  // content:// URI the installer requires - no manifest change needed beyond
  // the REQUEST_INSTALL_PACKAGES permission.
  await plugins.FileOpener.openFile({ path, mimeType: APK_MIME_TYPE });
  return path;
}
