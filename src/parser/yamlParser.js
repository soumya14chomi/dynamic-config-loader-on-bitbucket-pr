
// src/parser/yamlParser.js

/**
 * Flatten a nested YAML object into dot notation keys.
 * Example: { feature: { toggle: { newUI: true } } } -> { "feature.toggle.newUI": true }
 */

export function flattenYaml(obj, prefix = '') {
    let result = {};
    for (const [k, v] of Object.entries(obj)) {
        const newKey = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null) {
            Object.assign(result, flattenYaml(v, newKey));
        } else {
            result[newKey] = v;
        }
    }
    return result;
}

