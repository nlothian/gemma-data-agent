interface IconProps {
  size?: number;
  style?: React.CSSProperties;
}

interface MaterialIconProps extends IconProps {
  name: string;
  filled?: boolean;
}

function MaterialIcon({ name, size = 16, filled = false, style }: MaterialIconProps) {
  return (
    <span
      className="material-symbols-outlined"
      aria-hidden="true"
      style={{
        fontSize: size,
        lineHeight: 1,
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' ${size}`,
        userSelect: 'none',
        ...style,
      }}
    >
      {name}
    </span>
  );
}

export const SettingsIcon = (p: IconProps) => <MaterialIcon name="settings" {...p} />;
export const CloseIcon = (p: IconProps) => <MaterialIcon name="close" {...p} />;
export const EyeIcon = (p: IconProps) => <MaterialIcon name="visibility" {...p} />;
export const EyeOffIcon = (p: IconProps) => <MaterialIcon name="visibility_off" {...p} />;
export const PlusIcon = (p: IconProps) => <MaterialIcon name="add" {...p} />;
export const RefreshIcon = (p: IconProps) => <MaterialIcon name="refresh" {...p} />;
export const TrashIcon = (p: IconProps) => <MaterialIcon name="delete" {...p} />;
export const AlertCircleIcon = (p: IconProps) => <MaterialIcon name="error" {...p} />;
export const SendIcon = (p: IconProps) => <MaterialIcon name="send" {...p} />;
export const StopIcon = (p: IconProps) => <MaterialIcon name="stop" filled {...p} />;
export const PlayIcon = (p: IconProps) => <MaterialIcon name="play_arrow" filled {...p} />;
export const PauseIcon = (p: IconProps) => <MaterialIcon name="pause" filled {...p} />;
export const CompressIcon = (p: IconProps) => <MaterialIcon name="compress" filled {...p} />;
export const StepIcon = (p: IconProps) => <MaterialIcon name="skip_next" filled {...p} />;
export const ChevronRightIcon = (p: IconProps) => <MaterialIcon name="chevron_right" {...p} />;
export const ChevronDownIcon = (p: IconProps) => <MaterialIcon name="expand_more" {...p} />;
export const MaximizeIcon = (p: IconProps) => <MaterialIcon name="open_in_full" {...p} />;
export const MinimizeIcon = (p: IconProps) => <MaterialIcon name="close_fullscreen" {...p} />;
export const LoaderIcon = (p: IconProps) => <MaterialIcon name="progress_activity" {...p} />;
export const ChatAddOnIcon = (p: IconProps) => <MaterialIcon name="chat_add_on" {...p} />;
export const InfoIcon = (p: IconProps) => <MaterialIcon name="info" {...p} />;
export const CopyIcon = (p: IconProps) => <MaterialIcon name="content_copy" {...p} />;
export const CheckIcon = (p: IconProps) => <MaterialIcon name="check" {...p} />;
export const ClearAllIcon = (p: IconProps) => <MaterialIcon name="clear_all" {...p} />;
export const DatabaseIcon = (p: IconProps) => <MaterialIcon name="database" {...p} />;
export const RobotIcon = (p: IconProps) => <MaterialIcon name="smart_toy" {...p} />;
export const DataTableIcon = (p: IconProps) => <MaterialIcon name="table_chart" {...p} />;

// Brand logos — Material Symbols has no Python/React glyph, so we inline the
// official marks. Both render with `currentColor` so they pick up the tab's
// text colour.
export function PythonLogoIcon({ size = 16, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: 'inline-block', flexShrink: 0, ...style }}
    >
      <path d="M11.914 0C5.82 0 6.2 2.656 6.2 2.656l.007 2.752h5.814v.826H3.9S0 5.789 0 11.969c0 6.18 3.403 5.96 3.403 5.96h2.03v-2.867s-.109-3.42 3.35-3.42h5.766s3.24.052 3.24-3.148V3.202S18.28 0 11.914 0zM8.708 1.85c.578 0 1.046.474 1.046 1.058 0 .585-.468 1.058-1.046 1.058a1.052 1.052 0 0 1-1.046-1.058c0-.584.468-1.058 1.046-1.058z" />
      <path d="M12.087 24c6.092 0 5.712-2.656 5.712-2.656l-.007-2.752h-5.814v-.826h8.123S24 18.211 24 12.031c0-6.18-3.403-5.96-3.403-5.96h-2.03v2.867s.109 3.42-3.35 3.42H9.452s-3.24-.052-3.24 3.148v5.292S5.72 24 12.087 24zm3.206-1.85a1.052 1.052 0 0 1-1.046-1.058c0-.585.468-1.058 1.046-1.058.578 0 1.046.474 1.046 1.058 0 .584-.468 1.058-1.046 1.058z" />
    </svg>
  );
}

export function ReactLogoIcon({ size = 16, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-11.5 -10.23174 23 20.46348"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: 'inline-block', flexShrink: 0, ...style }}
    >
      <circle r="2.05" />
      <g stroke="currentColor" strokeWidth="1" fill="none">
        <ellipse rx="11" ry="4.2" />
        <ellipse rx="11" ry="4.2" transform="rotate(60)" />
        <ellipse rx="11" ry="4.2" transform="rotate(120)" />
      </g>
    </svg>
  );
}
