/**
 * Expo config plugin: release signing for Android without committing keys.
 *
 * When the environment variables below are present at Gradle build time the
 * release build is signed with the upload key; otherwise it falls back to the
 * debug key (installable APK for testing, NOT for Google Play).
 *
 *   TRAILPACK_UPLOAD_STORE_FILE      absolute path to the .jks/.keystore
 *   TRAILPACK_UPLOAD_STORE_PASSWORD
 *   TRAILPACK_UPLOAD_KEY_ALIAS
 *   TRAILPACK_UPLOAD_KEY_PASSWORD
 *
 * Generate a key once (keep it OUTSIDE the repository):
 *   keytool -genkeypair -v -storetype PKCS12 -keystore trailpack-upload.keystore \
 *     -alias trailpack -keyalg RSA -keysize 2048 -validity 10000
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// trailpack-release-signing';

function applySigning(contents) {
  if (contents.includes(MARKER)) return contents;
  const signingBlock = `signingConfigs {
        ${MARKER}
        trailpackRelease {
            def tpStore = System.getenv("TRAILPACK_UPLOAD_STORE_FILE")
            if (tpStore) {
                storeFile file(tpStore)
                storePassword System.getenv("TRAILPACK_UPLOAD_STORE_PASSWORD")
                keyAlias System.getenv("TRAILPACK_UPLOAD_KEY_ALIAS")
                keyPassword System.getenv("TRAILPACK_UPLOAD_KEY_PASSWORD")
            }
        }`;
  let out = contents.replace(/signingConfigs\s*\{/, signingBlock);
  out = out.replace(
    /(release\s*\{\s*\n\s*\/\/ Caution![^\n]*\n\s*\/\/ see[^\n]*\n\s*)signingConfig signingConfigs\.debug/,
    '$1signingConfig System.getenv("TRAILPACK_UPLOAD_STORE_FILE") ? signingConfigs.trailpackRelease : signingConfigs.debug',
  );
  if (!out.includes('signingConfigs.trailpackRelease')) {
    throw new Error('[withReleaseSigning] could not patch android/app/build.gradle release signingConfig');
  }
  return out;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('[withReleaseSigning] expected a Groovy build.gradle');
    }
    cfg.modResults.contents = applySigning(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.applySigning = applySigning;
