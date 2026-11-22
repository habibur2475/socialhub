import { PdfEditor } from '@/components/tools/pdf-editor/pdf-editor';

export const metadata = { title: 'PDF editor — SocialHub' };

export default function PdfEditorPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <PdfEditor />
    </div>
  );
}
