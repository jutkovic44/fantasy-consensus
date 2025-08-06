document.getElementById('startDraft').onclick = () => {
  document.getElementById('introOverlay').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('pauseResume').style.display = 'inline-block';
  console.log("Draft started.");
};
