/**
 * Writing an article.
 *
 * A client component: the preview, the excerpt and the reading time are computed in the
 * browser from the same kernel functions the server uses, so the preview cannot disagree
 * with what gets stored.
 */

import { ArticleComposer } from '@/components/blog/article-composer';

export default function NewArticlePage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[720px]">
      <ArticleComposer />
    </div>
  );
}
