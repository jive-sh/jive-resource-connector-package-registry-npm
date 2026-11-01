/**
 * The version a placeholder is published at. npm points `latest` at a package's first version whatever tag it is
 * published under, so the placeholder is the lowest version there is, and CI's first release replaces it.
 */
export const PLACEHOLDER_VERSION = "0.0.0";

export function placeholderDescription(packageName: string): string {
  return `Reserved by Jive: ${packageName}'s first release is published by its CI pipeline.`;
}
