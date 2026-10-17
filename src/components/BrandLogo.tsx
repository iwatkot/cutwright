import { t as uiText } from '../i18n/core';
import { websiteHref } from '../i18n/links';
import { APP_VERSION } from '../version';

/** The selected mark shares one accessible name with its visible wordmark. */
export default function BrandLogo() {
  const mark = <>
    <img className="brand-mark" src={`${import.meta.env.BASE_URL}branding/cutwright-icon.png`} width={24} height={24} alt="" aria-hidden="true" draggable={false} />
    <span className="brand-wordmark" aria-hidden="true">Cut<span className="brand-wordmark-accent">Wright</span></span>
    <span className="brand-version" aria-hidden="true">{APP_VERSION}</span>
  </>;
  // Desktop keeps its draggable brand until external URLs have a native handler.
  if (window.cutwright) return <div className="logo brand-logo" role="img" aria-label={uiText("CutWright {0}", { 0: APP_VERSION })}>{mark}</div>;
  return <a className="logo brand-logo" href={websiteHref()} target="_blank" rel="noopener noreferrer" aria-label={uiText("CutWright {0} home", { 0: APP_VERSION })} data-tooltip={uiText("CutWright home")}>{mark}</a>;
}
