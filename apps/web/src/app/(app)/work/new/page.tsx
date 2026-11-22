/** Posting a job: the create form. */

import { JobEditor } from '@/components/work/job-editor';

export const metadata = { title: 'Post a job — SocialHub Work' };

export default function NewJobPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[640px]">
      <JobEditor />
    </div>
  );
}
