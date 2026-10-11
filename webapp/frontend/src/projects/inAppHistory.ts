// t85 — a session-scoped reconstruction of the in-app navigation stack, so an in-app "Back"
// button can pop the browser history (nav(-1)) when there IS an in-app page behind us, and
// fall back to a logical parent only on a deep-link / fresh load (no in-app history to pop).
//
// AppRoot feeds every route change to recordVisit(); we infer push vs. back by comparing the
// new path to the stack: returning to the previous entry is a back (pop), a genuinely new path
// is a push. (Replace-navigations are rare and only happen around auth entry, well below any
// canvas — an occasional over-count there never affects a canvas/merge Back button, whose only
// question is "did an in-app page push us into this canvas?".) Kept dependency-free so
// inAppHistory.spec.ts can drive it directly.
let stack: string[] = [];

export function recordVisit(path: string): void {
  if (stack.length >= 2 && stack[stack.length - 2] === path) {
    stack.pop();                          // returned to the previous page → a back navigation
  } else if (stack[stack.length - 1] !== path) {
    stack.push(path);                     // a new page → a forward navigation
  }
  // same path as the top → a replace / no-op; leave the stack unchanged
}

/** True iff an in-app page sits behind the current one — i.e. nav(-1) lands inside the app. */
export function canGoBack(): boolean {
  return stack.length > 1;
}

/** Test hook — clear the reconstructed stack between cases. */
export function resetInAppHistory(): void {
  stack = [];
}
