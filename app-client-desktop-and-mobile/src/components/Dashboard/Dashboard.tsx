import { usePlatform } from '../../context/PlatformContext';
import { User } from '../../hooks/useAuth';
import { DashboardDesktop } from '../../views/desktop/DashboardDesktop';
import { DashboardMobile } from '../../views/mobile/DashboardMobile';

interface Props {
  user: User;
  onNavigate?: (view: any) => void;
}

export function Dashboard(props: Props) {
  const { platform } = usePlatform();

  if (platform === 'mobile') {
    return <DashboardMobile {...props} />;
  }

  return <DashboardDesktop {...props} />;
}

export default Dashboard;
