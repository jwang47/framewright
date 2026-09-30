// Runs segment.js off the main thread, so the page stays live while a
// subject mask is worked out.
import { segmentSubject } from './segment.js';

onmessage = ({ data: { id, img, strokes } }) => {
  try {
    const alpha = segmentSubject(img, strokes);
    postMessage({ id, alpha }, [alpha.buffer]);
  } catch (e) {
    postMessage({ id, error: e.message });
  }
};
