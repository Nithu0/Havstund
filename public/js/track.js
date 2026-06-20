/* Havstund — enkel, personvernvennlig besøkslogging (egen DB, ingen tredjepart). */
(function () {
  try {
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ sti: location.pathname, referrer: document.referrer || '' }),
    }).catch(function () {});
  } catch (e) {}
})();
