// One icon pack (Iconoir, outline) for the whole dashboard.
// Decorative by default (aria-hidden); labelled buttons carry the name.
import {
  Archive as ArchiveBase,
  ArrowLeft as ArrowLeftBase,
  Calendar as CalendarBase,
  Check as CheckBase,
  Clock as ClockBase,
  Copy as CopyBase,
  Eye as EyeBase,
  EyeClosed as EyeClosedBase,
  InfoCircle as InfoCircleBase,
  Key as KeyBase,
  Lock as LockBase,
  Menu as MenuBase,
  MoreHoriz as MoreHorizBase,
  NavArrowDown as NavArrowDownBase,
  NavArrowLeft as NavArrowLeftBase,
  NavArrowRight as NavArrowRightBase,
  Plus as PlusBase,
  Refresh as RefreshBase,
  Search as SearchBase,
  Settings as SettingsBase,
  ShieldCheck as ShieldCheckBase,
  Trash as TrashBase,
  TriangleFlag as TriangleFlagBase,
  User as UserBase,
  Xmark as XmarkBase,
} from "iconoir-react";
import type { ComponentType, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function make(Base: ComponentType<any>) {
  return function Icon({ size = 18, strokeWidth = 1.8, ...rest }: IconProps) {
    return <Base width={size} height={size} strokeWidth={strokeWidth} aria-hidden="true" {...rest} />;
  };
}

export const ArchiveIcon = make(ArchiveBase);
export const ArrowLeftIcon = make(ArrowLeftBase);
export const CalendarIcon = make(CalendarBase);
export const CheckIcon = make(CheckBase);
export const ClockIcon = make(ClockBase);
export const CopyIcon = make(CopyBase);
export const EyeIcon = make(EyeBase);
export const EyeClosedIcon = make(EyeClosedBase);
export const InfoCircleIcon = make(InfoCircleBase);
export const KeyIcon = make(KeyBase);
export const LockIcon = make(LockBase);
export const MenuIcon = make(MenuBase);
export const MoreHorizIcon = make(MoreHorizBase);
export const NavArrowDownIcon = make(NavArrowDownBase);
export const NavArrowLeftIcon = make(NavArrowLeftBase);
export const NavArrowRightIcon = make(NavArrowRightBase);
export const PlusIcon = make(PlusBase);
export const RefreshIcon = make(RefreshBase);
export const SearchIcon = make(SearchBase);
export const SettingsIcon = make(SettingsBase);
export const ShieldCheckIcon = make(ShieldCheckBase);
export const TrashIcon = make(TrashBase);
export const TriangleFlagIcon = make(TriangleFlagBase);
export const UserIcon = make(UserBase);
export const XmarkIcon = make(XmarkBase);
