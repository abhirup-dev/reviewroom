// Which form this screen is (kernel/presentation.ts), read from the device. Light on purpose: the hub page uses it too.
import { formFor, type Form } from './presentation';

const side = () => Math.min(screen.width, screen.height);
// no matchMedia (tests without a DOM): the desktop
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** The shorter screen side, CSS px: a phone at most PHONE_MAX, a tablet at most TABLET_MAX. */
const PHONE_MAX = 720, TABLET_MAX = 1024;
const small = () => touch() && side() <= PHONE_MAX;
const landscape = () => screen.orientation?.type.startsWith('landscape') ?? matchMedia('(orientation: landscape)').matches;
const forced = () => new URLSearchParams(globalThis.location?.search).has('phone');
/** This screen's form: a phone upright or `?phone` gets the phone shell; a phone on its side, the dock from the
 *  `tablet` layout, never saved over the reviewer's last layout. */
export const currentForm = (): Form => formFor({ small: small(), landscape: landscape(), forced: forced() });
/** A tablet (touch, shorter side 721–1024px) or a turned phone: the dock, starting from the `tablet` layout. */
export const isTablet = () => touch() && side() <= TABLET_MAX && currentForm() !== 'phone';
