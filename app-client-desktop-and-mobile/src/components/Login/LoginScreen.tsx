import { usePlatform } from '../../context/PlatformContext';
import { LoginDesktop } from '../../views/desktop/LoginDesktop';
import { LoginMobile } from '../../views/mobile/LoginMobile';

interface Props {
  onLogin: (username: string, password: string) => Promise<any>;
  onRegister?: (data: { name: string; username: string; password: string; key: string }) => Promise<any>;
  onGoToRegister?: () => void;
}

export function LoginScreen(props: Props) {
  const { platform } = usePlatform();

  if (platform === 'mobile') {
    return <LoginMobile {...props} />;
  }

  return <LoginDesktop {...props} />;
}

export default LoginScreen;
