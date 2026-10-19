// settings.html: 설정 is a modal over the app (features/settings-modal.js, docs/settings/), so this address only sends
// the browser on to it, over the 서비스 view: settings.html#remote → ./#settings/remote (lib/settings-route.js
// legacySection; test/ui-settings.test.ts keeps the two lists equal). A classic script in <head>, before anything paints.

(function () {
  var IDS = ['start', 'remote', 'write-devices', 'port-rules', 'notify', 'claude', 'secrets', 'display', 'about'];
  var id = location.hash.replace(/^#(settings\/?)?/, '');
  location.replace('./' + location.search + '#settings/' + (IDS.indexOf(id) >= 0 ? id : 'start'));
})();
