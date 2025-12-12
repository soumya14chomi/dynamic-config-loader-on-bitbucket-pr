
document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('saveBtn').addEventListener('click', saveOptions);

function saveOptions() {
    const maskSecrets = document.getElementById('maskSecrets').checked;
    const missingBehavior = document.getElementById('missingBehavior').value;
    const enableExtension = document.getElementById('enableExtension').checked;

    chrome.storage.sync.set({
        maskSecrets,
        missingBehavior,
        enableExtension
    }, () => {
        const status = document.getElementById('status');
        status.textContent = 'Settings saved!';
        setTimeout(() => status.textContent = '', 2000);
    });
}

function restoreOptions() {
    chrome.storage.sync.get({
        maskSecrets: true,
        missingBehavior: 'show',
        enableExtension: true
    }, (items) => {
        document.getElementById('maskSecrets').checked = items.maskSecrets;
        document.getElementById('missingBehavior').value = items.missingBehavior;
        document.getElementById('enableExtension').checked = items.enableExtension;
    });
}
