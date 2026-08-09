/**
 * Centralized icon mapping — single source of truth for all semantic icons.
 *
 * Import `ICON_MAP` and `AppIconName` from here. To add a new icon,
 * add a new entry to `AppIconName` and `ICON_MAP`.
 */
import {
    AlertCircle,
    AlertTriangle,
    Activity,
    Archive,
    BarChart3,
    Bell,
    Bug,
    Building2,
    CheckCircle2,
    CircleDashed,
    ClipboardList,
    Clock,
    Download,
    Eye,
    FileArchive,
    FileJson,
    FilePlus,
    FileSpreadsheet,
    FileText,
    FileWarning,
    GitBranch,
    Globe,
    Info,
    Link2,
    Lock,
    Map,
    MessageSquare,
    Package,
    Paperclip,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Rocket,
    Save,
    Search,
    Settings,
    Share2,
    Shield,
    ShieldCheck,
    TestTube,
    Upload,
    UserCheck,
    XCircle,
    type LucideIcon,
} from 'lucide-react';

/** All semantic icon names used across the app. */
export type AppIconName =
    | 'activity'
    | 'alertCircle'
    | 'archive'
    | 'assets'
    | 'bell'
    | 'bug'
    | 'checkCircle'
    | 'circleDashed'
    | 'clock'
    | 'comments'
    | 'practices'
    | 'create'
    | 'dashboard'
    | 'download'
    | 'edit'
    | 'error'
    | 'evidence'
    | 'export'
    | 'fileArchive'
    | 'fileJson'
    | 'fileSpreadsheet'
    | 'fileWarning'
    | 'frameworks'
    | 'globe'
    | 'info'
    | 'link'
    | 'lock'
    | 'mappings'
    | 'overview'
    | 'package'
    | 'plus'
    | 'policies'
    | 'preview'
    | 'publish'
    | 'refresh'
    | 'risks'
    | 'run'
    | 'save'
    | 'search'
    | 'settings'
    | 'share'
    | 'shield'
    | 'success'
    | 'tasks'
    | 'templates'
    | 'tests'
    | 'upload'
    | 'userCheck'
    | 'versions'
    | 'warning';

/** Map from semantic name → lucide-react component. */
export const ICON_MAP: Record<AppIconName, LucideIcon> = {
    activity: Activity,
    alertCircle: AlertCircle,
    archive: Archive,
    assets: Building2,
    bell: Bell,
    bug: Bug,
    checkCircle: CheckCircle2,
    circleDashed: CircleDashed,
    clock: Clock,
    comments: MessageSquare,
    practices: ShieldCheck,
    create: FilePlus,
    dashboard: BarChart3,
    download: Download,
    edit: Pencil,
    error: XCircle,
    evidence: Paperclip,
    export: Download,
    fileArchive: FileArchive,
    fileJson: FileJson,
    fileSpreadsheet: FileSpreadsheet,
    fileWarning: FileWarning,
    frameworks: Map,
    globe: Globe,
    info: Info,
    link: Link2,
    lock: Lock,
    mappings: Map,
    overview: ClipboardList,
    package: Package,
    plus: Plus,
    policies: FileText,
    preview: Eye,
    publish: Rocket,
    refresh: RefreshCw,
    risks: AlertTriangle,
    run: Play,
    save: Save,
    search: Search,
    settings: Settings,
    share: Share2,
    shield: Shield,
    success: CheckCircle2,
    tasks: CheckCircle2,
    templates: ClipboardList,
    tests: TestTube,
    upload: Upload,
    userCheck: UserCheck,
    versions: GitBranch,
    warning: AlertTriangle,
};

/** Default icon size in px — adjust here to change globally. */
export const ICON_DEFAULT_SIZE = 18;
