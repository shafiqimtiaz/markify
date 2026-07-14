const DEFAULTS = {
  includeTitle: true, includeMetadata: true, keepLinks: true,
  keepImages: true, codeBlocks: true, smartExtract: true,
  extraInclude: '', extraExclude: '',
  yamlTemplate: '---\ntitle: "{title}"\nsource: "{url}"\ndate: "{date}"\nsite_type: "{site_type}"\nauthor: "{author}"\ndescription: "{description}"\n---'
};

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('resetBtn').addEventListener('click', resetSettings);
  document.getElementById('shortcutsLink').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
});

function loadSettings() {
  chrome.storage.local.get(['settings'], r => {
    const s = { ...DEFAULTS, ...r.settings };
    document.getElementById('defTitle').checked = s.includeTitle;
    document.getElementById('defMetadata').checked = s.includeMetadata;
    document.getElementById('defLinks').checked = s.keepLinks;
    document.getElementById('defImages').checked = s.keepImages;
    document.getElementById('defCodeBlocks').checked = s.codeBlocks;
    document.getElementById('defSmartExtract').checked = s.smartExtract;
    document.getElementById('extraInclude').value = s.extraInclude || '';
    document.getElementById('extraExclude').value = s.extraExclude || '';
    document.getElementById('yamlTemplate').value = s.yamlTemplate || DEFAULTS.yamlTemplate;
  });
}

function saveSettings() {
  const settings = {
    includeTitle: document.getElementById('defTitle').checked,
    includeMetadata: document.getElementById('defMetadata').checked,
    keepLinks: document.getElementById('defLinks').checked,
    keepImages: document.getElementById('defImages').checked,
    codeBlocks: document.getElementById('defCodeBlocks').checked,
    smartExtract: document.getElementById('defSmartExtract').checked,
    extraInclude: document.getElementById('extraInclude').value.trim(),
    extraExclude: document.getElementById('extraExclude').value.trim(),
    yamlTemplate: document.getElementById('yamlTemplate').value,
  };
  chrome.storage.local.set({ settings }, () => {
    const msg = document.getElementById('savedMsg');
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 2000);
  });
}

function resetSettings() {
  chrome.storage.local.set({ settings: DEFAULTS }, () => {
    loadSettings();
    const msg = document.getElementById('savedMsg');
    msg.textContent = 'Reset!';
    msg.classList.add('show');
    setTimeout(() => { msg.classList.remove('show'); msg.textContent = 'Saved!'; }, 2000);
  });
}