export function shouldAutoFollowChat(manualNavigation: boolean, nearBottom: boolean): boolean {
  return !manualNavigation && nearBottom;
}
