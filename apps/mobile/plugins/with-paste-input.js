// react-native-paste-input needs two things from the native project.
// Its podspec raises unless RCT_NEW_ARCH_ENABLED=1, which React Native 0.86 no longer exports
// because the new architecture is always on. And it finds the text inputs it patches through the
// root view factory, so AppDelegate hands it over once React Native has started. The pod has no
// Swift module, so the call goes through the Objective-C runtime.
const { withAppDelegate, withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const ANCHOR = "launchOptions: launchOptions)\n#endif";
const SETUP = `
    (NSClassFromString("PasteInputModule") as? NSObject.Type)?
      .perform(NSSelectorFromString("setup:"), with: factory.rootViewFactory)`;
const ENV_LINE = "ENV['RCT_NEW_ARCH_ENABLED'] = '1'\n";

function withPodfileEnv(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const src = fs.readFileSync(file, "utf8");
      if (!src.includes(ENV_LINE)) fs.writeFileSync(file, ENV_LINE + src);
      return cfg;
    },
  ]);
}

module.exports = function withPasteInput(config) {
  const withSetup = withAppDelegate(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (src.includes("PasteInputModule")) return cfg;
    if (!src.includes(ANCHOR)) {
      throw new Error(
        "with-paste-input: AppDelegate.swift no longer matches the expected template",
      );
    }
    cfg.modResults.contents = src.replace(ANCHOR, `${ANCHOR}\n${SETUP}`);
    return cfg;
  });
  return withPodfileEnv(withSetup);
};
