import { MODE_KEY, VARS_CACHE_KEY } from "./model";

/**
 * Blocking script for <head>: applies the device's mode and the cached theme
 * variables before first paint, so a reload never flashes the default theme.
 * `apply.ts` writes the cache (`{ light: vars, dark: vars }`) on every change.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem(${JSON.stringify(MODE_KEY)})||"dark";var dark=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(dark)d.classList.add("dark");else d.classList.remove("dark");try{var c=JSON.parse(localStorage.getItem(${JSON.stringify(VARS_CACHE_KEY)})||"null");var v=c&&c[dark?"dark":"light"];if(v)for(var k in v)if(k.slice(0,2)==="--"&&typeof v[k]==="string")d.style.setProperty(k,v[k])}catch(e){}}catch(e){d.classList.add("dark")}})()`;
