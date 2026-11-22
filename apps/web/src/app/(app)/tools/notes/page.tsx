import { NotesTool } from '@/components/tools/notes/notes';

export const metadata = { title: 'Notes — SocialHub' };

export default function NotesPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <NotesTool />
    </div>
  );
}
