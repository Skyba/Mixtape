const { withAndroidManifest } = require("expo/config-plugins");

// A fold, a split-screen resize or a display-size change recreates the
// activity unless it handles these itself, and recreating it unmounts the
// record screen mid-take. Portrait-only, so nothing needs a fresh layout pass.
const EXTRA = ["smallestScreenSize", "density"];

module.exports = function withMixtapeTake(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    const main = app?.activity?.find((a) => a.$["android:name"] === ".MainActivity");
    if (main) {
      const have = (main.$["android:configChanges"] || "").split("|").filter(Boolean);
      main.$["android:configChanges"] = [...new Set([...have, ...EXTRA])].join("|");
    }
    return cfg;
  });
};
