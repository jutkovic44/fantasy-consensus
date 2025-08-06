document.getElementById('startDraft').onclick = () => {
  document.getElementById('introOverlay').style.display = 'none';
  document.getElementById('pauseResume').style.display = 'inline-block';
  console.log("Draft started. Rankings revealed.");
  // You'd normally call setupDraft() or similar here.
};
