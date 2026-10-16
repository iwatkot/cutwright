/** The selected mark shares one accessible name with its visible wordmark. */
export default function BrandLogo() {
  const mark = <>
    <img className="brand-mark" src={`${import.meta.env.BASE_URL}branding/cutwright-icon.png`} width={24} height={24} alt="" aria-hidden="true" draggable={false} />
    <span className="brand-wordmark" aria-hidden="true">Cut<span className="brand-wordmark-accent">Wright</span></span>
  </>;
  // Desktop keeps its draggable brand until external URLs have a native handler.
  if (window.cutwright) return <div className="logo brand-logo" role="img" aria-label="CutWright">{mark}</div>;
  return <a className="logo brand-logo" href="https://cutwright.cc" target="_blank" rel="noopener noreferrer" aria-label="CutWright home" data-tooltip="CutWright home">{mark}</a>;
}
