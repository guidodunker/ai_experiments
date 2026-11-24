const APPROVAL = /^(approved|freigegeben)[!.]?$/i

/** Nur genau dieses Wort, damit „approved? noch nicht“ keinen Merge auslöst. */
export function isApproval(text: string): boolean {
  return APPROVAL.test(text.trim())
}
