
console.log("[Config Key Finder] Background service worker running.");

// Listen for messages from content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetchConfig') {
        const { url } = message;
        console.log(`[Config Key Finder] Fetching config from: ${url}`);

        fetch(url, { credentials: 'include' }) // Use browser session for auth
            .then(response => {
                if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
                return response.text();
            })
            .then(text => {
                sendResponse({ success: true, content: text });
            })
            .catch(error => {
                console.error("[Config Key Finder] Fetch error:", error);
                sendResponse({ success: false, error: error.message });
            });

        return true; // Keep the message channel open for async response
    }
});
