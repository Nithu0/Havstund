/* Havstund — nettside-interaksjon (vanilla JS, ingen avhengigheter) */

// År i footer + mobilmeny. Null-guard hvert element og kjør fra DOMContentLoaded:
// på sider uten #aar / #navToggle / #navLinks skal ikke resten av skriptet dø.
function initNav() {
  const aar = document.getElementById('aar');
  if (aar) aar.textContent = new Date().getFullYear();

  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
    links.querySelectorAll('a').forEach(a =>
      a.addEventListener('click', () => links.classList.remove('open'))
    );
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNav);
else initNav();

// Reveal-animasjon ved scroll
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// Booking-modal
const modal = document.getElementById('bookModal');
const modalTitle = document.getElementById('modalTitle');
const modalText = document.getElementById('modalText');
const modalMail = document.getElementById('modalMail');
const EPOST = 'post@havstund.no';

function openBook(emne) {
  modalTitle.textContent = emne;
  modalText.textContent = 'Send oss en forespørsel, så finner vi et tidspunkt som passer og svarer deg raskt.';
  const subject = encodeURIComponent('Havstund — ' + emne);
  const body = encodeURIComponent('Hei Havstund!\n\nJeg er interessert i: ' + emne + '\n\nØnsket dato/antall personer:\n\nNavn:\nTelefon:\n\nHilsen');
  modalMail.href = `mailto:${EPOST}?subject=${subject}&body=${body}`;
  modal.classList.add('open');
}
document.querySelectorAll('[data-book]').forEach(btn =>
  btn.addEventListener('click', (e) => { e.preventDefault(); openBook(btn.getAttribute('data-book')); })
);
document.getElementById('modalClose').addEventListener('click', () => modal.classList.remove('open'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

// Kontaktskjema -> mailto
const sendBtn = document.getElementById('sendBtn');
if (sendBtn) {
  sendBtn.addEventListener('click', () => {
    const navn = document.getElementById('navn').value.trim();
    const epost = document.getElementById('epost').value.trim();
    const emne = document.getElementById('emne').value;
    const melding = document.getElementById('melding').value.trim();
    if (!navn || !epost) { alert('Fyll inn navn og e-post.'); return; }
    const subject = encodeURIComponent('Havstund — ' + emne);
    const body = encodeURIComponent(`Navn: ${navn}\nE-post: ${epost}\n\n${melding}`);
    window.location.href = `mailto:${EPOST}?subject=${subject}&body=${body}`;
  });
}
