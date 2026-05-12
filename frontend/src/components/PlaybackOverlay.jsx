import { useEffect, useState } from 'react';

export default function PlaybackOverlay({ visible, stepIndex = 0, totalSteps = 0, description = '', onClose }) {
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // trigger pulse animation on step change
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 260);
    return () => clearTimeout(t);
  }, [stepIndex, visible]);

  if (!visible) return null;

  return (
    <div className="playback-overlay" aria-live="polite">
      <div className={`playback-box${pulse ? ' playback-change' : ''}`} role="status">
        <div className="playback-main">{description || `Executing Step ${stepIndex}`}</div>
        <div className="playback-meta">{stepIndex > 0 && totalSteps > 0 ? `${stepIndex} of ${totalSteps}` : ''}</div>
      </div>
    </div>
  );
}
