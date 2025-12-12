***

# **Config Key Finder - Chrome Extension**

## ✅ Overview

**Config Key Finder** is a Chrome extension that runs on **Bitbucket Pull Request pages**. It highlights configuration keys in the code (e.g., `@Value("${...}")` or `@ConfigurationProperties(prefix="...")`) and shows their values from `application.properties` or `application.yml` files **present in the PR**.  
This helps reviewers quickly understand configuration impacts without searching manually.

***

## ✅ Features

*   Detects:
    *   `@ConfigurationProperties(prefix="...")` in classes and records.
    *   Fields inside classes and record components.
    *   `@Value("${...}")` annotations.
*   Fetches and parses config files **from the PR itself** (no external branch fetch).
*   Supports:
    *   `.properties` and `.yml` files.
    *   Spring relaxed binding (kebab-case, snake\_case, camelCase).
*   Inline badges with tooltips showing config values.
*   Masks sensitive values (passwords, secrets) if enabled.
*   Options page for customization.

***

## ✅ Installation

1.  Clone or download this repository.
2.  Open **Chrome** → `chrome://extensions/`.
3.  Enable **Developer mode** (top-right).
4.  Click **Load unpacked**.
5.  Select the project folder (where `manifest.json` is located).
6.  The extension will appear in your extensions list.

***

## ✅ Usage

1.  Navigate to a **Bitbucket Pull Request** page.
2.  The extension automatically scans:
    *   Code blocks for config annotations.
    *   PR file list for `application.yml` or `application.properties`.
3.  If config files exist in the PR:
    *   Fetch and parse them.
    *   Display badges next to detected keys with actual values.
4.  If no config files exist:
    *   Show badges with “Not set” or hide them (based on settings).

***

## ✅ Options

Click **Extension → Details → Options** to configure:

*   ✅ Mask sensitive values (passwords, secrets).
*   ✅ Behavior when config files are missing:
    *   Show badges with “Not set”.
    *   Hide badges.
*   ✅ Enable/disable extension on PR pages.

***

## ✅ Project Structure

    config-key-finder/
    ├── manifest.json
    ├── src/
    │   ├── content.js           # Main logic for scanning and injecting badges
    │   ├── background.js        # (Optional) Service worker for advanced fetch logic
    │   ├── parser/
    │   │   ├── keyNormalizer.js # Normalize keys for relaxed binding
    │   │   ├── propertiesParser.js
    │   │   └── yamlParser.js
    │   ├── ui/
    │   │   ├── tooltip.css      # Badge and tooltip styling
    │   └── options/
    │       ├── options.html     # Options page UI
    │       └── options.js       # Options page logic
    └── assets/
        └── icon.png

***

## ✅ Tech Stack

*   **JavaScript** (Content script, parsers, options page)
*   **HTML/CSS** (Options page, tooltips)
*   **Chrome Extension API** (Manifest V3)
*   **Optional:** js-yaml for YAML parsing.

***

## ✅ Future Enhancements

*   Support nested records and complex types (Maps, Lists).
*   Profile-specific configs (`application-prod.yml`).
*   Better UI for badges (expandable details).
*   Debug overlay for detected keys and parsed configs.

***

***

### ✅ Next Step: **Testing**

Here’s what we’ll do:

1.  Load the extension in Chrome.
2.  Open a Bitbucket PR with:
    *   A Java class or record annotated with `@ConfigurationProperties`.
    *   A config file (`application.yml` or `application.properties`) in the PR.
3.  Verify:
    *   Badges appear next to annotations.
    *   Tooltips show correct values.
    *   Options page settings apply (mask secrets, hide badges).

***
