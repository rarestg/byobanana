// Start the landing hero demo video, respecting reduced-motion. The <video> markup ships
// without `autoplay`: visitors who prefer reduced motion (or run without JS) keep the poster
// and the native controls, and never fetch the video bytes (preload="metadata").
(function () {
  var video = document.querySelector(".byo-showcase-figure video");
  if (!video || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Muted playback is autoplay-policy safe; if a browser still refuses, the
  // poster + controls remain and the visitor can press play.
  video.play().catch(function () {});
})();
