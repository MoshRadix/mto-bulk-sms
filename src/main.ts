import { initializeApp } from './auth';

function initializeRainWalker() {
  const walker = document.getElementById('rain-walker');
  if (!walker || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let isCrossing = false;
  const wait = (duration: number) => new Promise<void>((resolve) => window.setTimeout(resolve, duration));

  const crossWindow = async () => {
    isCrossing = true;
    const edgeOffset = 50;
    const viewportWidth = Math.max(window.innerWidth, 320);
    let direction = Math.random() >= 0.5 ? 1 : -1;
    let position = direction === 1 ? -edgeOffset : viewportWidth + edgeOffset;
    let madeDecision = false;
    const pose = walker.querySelector<HTMLElement>('.walker-pose');

    walker.classList.add('is-visible');

    const animateTo = async (from: number, to: number, duration: number, easing = 'ease-in-out') => {
      const animation = walker.animate(
        [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
        { duration, easing, fill: 'forwards' },
      );
      await animation.finished.catch(() => undefined);
    };

    const lookAround = async () => {
      if (!pose) return;
      pose.style.setProperty('--walker-look', '-22deg');
      await wait(420);
      pose.style.setProperty('--walker-look', '22deg');
      await wait(620);
      pose.style.setProperty('--walker-look', '0deg');
      await wait(360);
    };

    // Occasionally the figure only peeks out, pauses, and retreats as if it
    // changed its mind about crossing in the rain.
    if (Math.random() < 0.28) {
      const peekDistance = 8 + Math.random() * 18;
      const peekPosition = position + direction * peekDistance;
      await animateTo(position, peekPosition, 650, 'ease-out');
      await wait(450 + Math.random() * 700);

      if (Math.random() < 0.62) {
        await animateTo(peekPosition, position, 700, 'ease-in-out');
        const peekFade = walker.animate([{ opacity: 0.78 }, { opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'forwards' });
        await peekFade.finished.catch(() => undefined);
        walker.getAnimations().forEach((animation) => animation.cancel());
        walker.classList.remove('is-visible');
        isCrossing = false;
        return;
      }

      position = peekPosition;
    }

    // Start exactly outside the viewport, then always perform the first segment.
    // Using an unconditional loop avoids rejecting either edge position before
    // the figure has had a chance to enter the window.
    while (true) {
      const target = direction === 1 ? viewportWidth + edgeOffset : -edgeOffset;
      const distance = Math.abs(target - position);
      const modeRoll = Math.random();
      const mode = modeRoll < 0.18 ? 'sprint' : modeRoll < 0.5 ? 'run' : 'walk';
      const speed = mode === 'sprint' ? 125 + Math.random() * 35 : mode === 'run' ? 78 + Math.random() * 28 : 38 + Math.random() * 16;
      const step = mode === 'sprint' ? 0.3 : mode === 'run' ? 0.45 : 0.72;
      walker.style.setProperty('--walker-step', `${step}s`);
      walker.style.setProperty('--walker-scale', direction === 1 ? '1' : '-1');
      walker.style.setProperty('--walker-lean', direction === 1 ? '1deg' : '-1deg');

      const mayPause = !madeDecision && distance > 300 && Math.random() < 0.3;
      const mayTurn = !madeDecision && !mayPause && distance > 220 && Math.random() < 0.42;
      const travelDistance = mayPause || mayTurn ? distance * (0.35 + Math.random() * 0.25) : distance;
      const segmentTarget = position + direction * travelDistance;
      const duration = (travelDistance / speed) * 1000;
      await animateTo(position, segmentTarget, duration);
      position = segmentTarget;

      if (mayPause) {
        madeDecision = true;
        walker.classList.add('is-paused');
        await wait(220 + Math.random() * 380);
        await lookAround();
        walker.classList.remove('is-paused');
        // The next segment chooses a fresh walk/run/sprint pace.
        continue;
      }

      if (mayTurn) {
        madeDecision = true;
        direction *= -1;
      } else {
        break;
      }
    }

    const fade = walker.animate([{ opacity: 0.78 }, { opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'forwards' });
    await fade.finished.catch(() => undefined);
    walker.getAnimations().forEach((animation) => animation.cancel());
    walker.classList.remove('is-visible');
    isCrossing = false;
  };

  const schedule = () => {
    window.setTimeout(() => {
      if (!isCrossing) void crossWindow().then(schedule);
    }, 18000 + Math.random() * 30000);
  };

  schedule();
}

initializeRainWalker();

// Authentication chooses setup, login, or the dashboard based on main-process readiness.
initializeApp();
