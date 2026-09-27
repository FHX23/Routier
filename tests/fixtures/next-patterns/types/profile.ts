export type ProfileInput = {
  userId: string;
  firstName?: string;
  lastName?: string;
  newsletter?: boolean;
};

export type ProfileUpdate = Partial<Omit<ProfileInput, 'userId'>>;
