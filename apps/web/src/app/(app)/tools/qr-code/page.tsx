import { QrCodeTool } from '@/components/tools/qr-code/qr-code';

export const metadata = { title: 'QR code — SocialHub' };

export default function QrCodePage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <QrCodeTool />
    </div>
  );
}
