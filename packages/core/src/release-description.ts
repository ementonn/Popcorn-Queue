export interface ReleaseDescriptionInput {
  releaseName?: string;
  releaseNotes?: string;
  mediaInfoText?: string;
  bdInfoText?: string;
  screenshots?: string[];
}

export function buildReleaseDescription(input: ReleaseDescriptionInput): string {
  const sections: string[] = [];
  const releaseName = input.releaseName?.trim();
  if (releaseName) sections.push(`[size=4][b]${releaseName}[/b][/size]`);

  const releaseNotes = input.releaseNotes?.trim();
  if (releaseNotes) sections.push(releaseNotes);

  const bdInfoText = input.bdInfoText?.trim();
  const mediaInfoText = input.mediaInfoText?.trim();
  if (bdInfoText) {
    sections.push(`BDInfo:\n${bdInfoText}`);
  } else if (mediaInfoText) {
    sections.push(mediaInfoText);
  }

  const screenshots = (input.screenshots ?? []).map((url) => url.trim()).filter(Boolean);
  if (screenshots.length) sections.push(screenshots.map((url) => `[img]${url}[/img]`).join("\n\n"));

  return sections.join("\n\n").trim();
}
