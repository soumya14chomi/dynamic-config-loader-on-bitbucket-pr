

/**
 * Parse a .properties file into a key-value map.
 */

export function parseProperties(text) {
    const map = {};
    text.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const [key, ...rest] = line.split('=');
        if (key && rest.length) {
            map[key.trim()] = rest.join('=').trim();
        }
    });
    return map;
}

