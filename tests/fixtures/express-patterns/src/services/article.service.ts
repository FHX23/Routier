const VISIBILITY = { public: 1, unlisted: 2 };
const LANGUAGES = { en: 'English', es: 'Español' };

function buildWhere(query: any) {
  return { tag: query.tag, author: query.author };
}

export const listArticles = async (query: any) => {
  const where = buildWhere(query);
  return { where, take: Number(query.limit) || 10 };
};

export const createArticle = async (article: any) => {
  const { title, description, tagList, visibility, language } = article;
  if (!(visibility in VISIBILITY) || !Object.keys(LANGUAGES).includes(language)) throw new Error('Invalid article');
  return { title, description, tagList, visibility, language };
};
