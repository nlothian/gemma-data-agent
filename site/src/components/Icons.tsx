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
