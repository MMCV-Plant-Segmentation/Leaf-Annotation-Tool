// t85 — deterministic parent route for the annotator / merge canvas "Back" button.
// The toolbar previously ran `nav(-1)` (browser-history back), which breaks on a pasted or
// deep-linked canvas URL: there is no in-app history entry to return to, so Back either
// leaves the app or dead-ends. The project hub is always a valid parent of a batch canvas
// (`/projects/:id/batches/:batchId[/merge]`), so navigate there unconditionally — in the
// normal in-app flow that is the same place history-back already went.
export function projectHubRoute(projectId: string | undefined): string {
  return projectId ? `/projects/${projectId}` : '/projects';
}
