
export function normalizeKey(name) {
    const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const snake = kebab.replace(/-/g, '_');
    return [kebab, name, snake];
}
