// Chrome renders PDFs in a plugin document; a floating button is the only way to
// offer an action inside it.
const isPdf =
  document.contentType === 'application/pdf' ||
  /\.pdf(\?|#|$)/i.test(location.href) ||
  !!document.querySelector('embed[type="application/pdf"]');

if (isPdf && window.top === window) {
  const button = document.createElement('button');
  button.id = 'flash-rsvp-launch';
  button.type = 'button';
  button.textContent = 'Read with Flash';
  button.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-pdf', url: location.href });
  });
  document.documentElement.append(button);
}
