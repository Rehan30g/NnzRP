/* js/utils/nativeExport.js - Cross-platform "save this text as a file" helper.
 *
 * Desktop Electron / plain browser / PWA: the classic <a download> blob-URL
 * trick. Works everywhere EXCEPT inside the installed Android APK's
 * Capacitor WebView, where it silently does nothing on many devices - no
 * download, no error, no toast, nothing - which is exactly the reported bug
 * ("kalau ekspor ga terjadi apa apa"). A WebView has no browser download
 * manager to hand the blob to.
 *
 * Capacitor Android: writes the text into the app's own cache dir via the
 * Filesystem plugin, then hands that file to the OS share sheet via the
 * Share plugin - which on Android includes "Save to Files" / "Save to
 * Drive" / any installed file manager, i.e. exactly the native "pick a
 * destination folder" flow this was asked for, instead of a silent no-op.
 *
 * Both plugins are read off `window.Capacitor.Plugins` at call time, never
 * imported as npm packages - this app has no bundler (see serve.js's own
 * "zero-dependency" note) and loads every JS file as a plain relative-import
 * ES module straight in the browser, so a bare `import '@capacitor/filesystem'`
 * specifier could never resolve there. `@capacitor/filesystem`/`@capacitor/share`
 * are devDependencies purely so `npx cap sync android` registers them into the
 * native Android project - the native bridge auto-injects `window.Capacitor.
 * Plugins.<Name>` once registered, exactly the same access pattern js/app.js
 * already uses for `@capacitor/app`'s backButton listener.
 */
export async function saveTextFile(filename, text, { mimeType = 'application/json' } = {}) {
  const plugins = window.Capacitor?.Plugins;
  if (window.Capacitor?.isNativePlatform?.() && plugins?.Filesystem && plugins?.Share) {
    // 'CACHE' / 'utf8' passed as plain strings (not the Directory/Encoding
    // enum objects @capacitor/filesystem exports) - those enums are just
    // string constants at runtime, and importing them would hit the same
    // no-bundler problem described above.
    const { uri } = await plugins.Filesystem.writeFile({
      path: filename,
      data: text,
      directory: 'CACHE',
      encoding: 'utf8'
    });
    await plugins.Share.share({ title: filename, url: uri });
    return;
  }

  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
