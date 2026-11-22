/** One job, keyed on its id so a state change on one job never leaks into another. */

'use client';

import { useParams } from 'next/navigation';

import { JobDetail } from '@/components/work/job-detail';

export default function JobPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();

  return (
    <div className="mx-auto max-w-[720px]">
      <JobDetail key={params.id} id={params.id} />
    </div>
  );
}
