/** One contract: its plan, its escrow, and the moves this viewer may make. */

'use client';

import { useParams } from 'next/navigation';

import { ContractView } from '@/components/work/contract-view';

export default function ContractPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();

  return (
    <div className="mx-auto max-w-[720px]">
      <ContractView key={params.id} id={params.id} />
    </div>
  );
}
