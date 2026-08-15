import mathildePortrait from './assets/crew/mathilde/portrait.jpg'

const mathildePhotoModules = import.meta.glob(
  './assets/crew/mathilde/archive/*.jpg',
  { eager: true, query: '?url', import: 'default' },
)
const mathildeVideoModules = import.meta.glob(
  './assets/crew/mathilde/archive/*.mp4',
  { eager: true, query: '?url', import: 'default' },
)
const mathildeVideoPosterModules = import.meta.glob(
  './assets/crew/mathilde/archive/video-posters/*.jpg',
  { eager: true, query: '?url', import: 'default' },
)

const mathildeCurrentMediaIds = new Set([
  '000077960005',
  '000077960013',
  '6a3c9e21-7bee-4182-b31c-dc29822e3523',
  'a478f97d-e554-41be-9ea9-c28b9a118353',
  'c7392c65-38a3-4bd1-91dc-25167a186019',
  'd3ca4ec7-9f9c-4d8b-9e06-2dbc0a3bdd2a',
  'img-0120-2',
  'img-0708',
  'img-0768-3',
  'img-1470',
  'img-1680',
  'img-2117',
  'img-2971',
  'img-2981',
  'img-2991',
  'img-3237',
  'img-3800',
  'img-4342',
  'img-4714',
  'img-4726-2',
  'img-4761',
  'img-5446',
  'img-5849',
  'img-5981',
  'img-6011',
  'img-6092',
  'img-6107',
  'img-6133',
  'img-6138',
  'img-6280-2',
  'img-6336',
  'img-6526',
  'img-6543',
  'img-6548',
  'img-7734',
  'img-7824',
  'img-8687',
  'img-8712',
  'img-8723',
  'img-8727',
  'img-8776',
  'img-8790',
  'img-8791',
  'img-9589',
  'img-9592',
  'img-9828',
  'img_6024',
  'img_6519',
  'img_8708',
  'ppc0719',
  'ppc1143',
  'ppc1789-2',
  'ppc5900-2',
  'ppc6870',
  'ppc6913',
  'ppc7338',
  'ppc7552',
  'pxl-20241019-151704936',
])

const mediaId = path => path.split('/').pop().replace(/\.[^.]+$/, '')
const mathildeGallery = [
  ...Object.entries(mathildePhotoModules).map(([path, src]) => ({
    id: mediaId(path),
    type: 'image',
    src,
    alt: 'Photo from Mathilde’s running archive.',
  })),
  ...Object.entries(mathildeVideoModules).map(([path, src]) => {
    const id = mediaId(path)
    return {
      id,
      type: 'video',
      src,
      posterSrc:
        mathildeVideoPosterModules[
          `./assets/crew/mathilde/archive/video-posters/${id}.jpg`
        ],
      alt: 'Video from Mathilde’s running archive.',
    }
  }),
]
  .filter(item => mathildeCurrentMediaIds.has(item.id))
  .sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }),
  )

export const crewMembers = [
  {
    id: 'mathilde',
    name: 'Mathilde Giroud',
    profileName: 'Mathilde',
    role: 'Pacer · final 11 miles',
    route: 'Tennessee Valley → Golden Gate Park',
    actualFromMi: 91.4,
    actualToMi: 102.4,
    portraitSrc: mathildePortrait,
    portraitAlt: 'Mathilde smiling beside a mountain lake.',
    interview: [
      {
        id: 'fear-and-love',
        title: 'Fear, love, and what remains',
        exchanges: [
          {
            question: 'What were some of the most intense things you have felt?',
            answer:
              'I think it is when you feel you are really walking on the edge. The first night at UTMB, it was snowing and very cold. You could feel that you were doing something very hard and intense, but at the same time you knew you might experience that exact moment only once in your life.',
          },
          {
            answer:
              'You realize how hard and dangerous it can be, but you are fully inside it. The adrenaline cuts off the fear. Your full body and full mind are in that experience, and you embrace the fear and the excitement at the same time. It is eye-opening not to be stopped by the fear itself and to accept both at once. That is what I reach for.',
          },
          {
            question: 'Is it the danger, or something else?',
            answer:
              'The other moment I love is when you realize the people surrounding you and the love. Seeing my family at Chamonix, the love I felt was multiplied. Even if they were not running, I could see that their emotions were ten times stronger, too. Going through that is a booster in many relationships.',
          },
          {
            answer:
              'In these long races, I feel I am marking my mind and body with something that cannot be erased. No matter what happens in the future, nobody can take that away from me. You develop this mental and physical strength, and you feel confident even if you get injured later or cannot finish the next one. You have done it once.',
          },
        ],
      },
      {
        id: 'rhythm-and-noise',
        title: 'Finding rhythm in the noise',
        exchanges: [
          {
            question: 'What happens when you find your rhythm?',
            answer:
              'When I run, especially long distance, I find my rhythm. I know the sounds of things: my steps going tap, tap, tap, and the sound of my bag. Those little sounds tell me that I am moving in my rhythm, and they trigger something comforting in me.',
          },
          {
            answer:
              'Even if I have a very bad moment during a race, such as a GI issue or pain somewhere, I can stay calm and steady because I am trained for that. I can go with the flow no matter what happens. I think it helps in life, too: sustaining your flow through the highs and the lows.',
          },
          {
            question: 'How does that composure transfer into life?',
            answer:
              'Training and racing teach you to problem-solve and choose how you react when something goes wrong. You can get caught in the drama, or you can stay with the problem and ask for help. Life has more noise, more people, and more emotions pulling you in different directions, but the mechanism is the same.',
          },
          {
            answer:
              'At UTMB I remembered: you do not choose what happens, but you get to choose how you react. I could be mad and give my whole crew a bad experience, or stay calm, find solutions, and have fun, even if it was painful.',
          },
        ],
      },
      {
        id: 'redemption-and-bigger-reasons',
        title: 'Redemption and bigger reasons',
        exchanges: [
          {
            question: 'What made UTMB bigger than a race?',
            answer:
              'UTMB was one of the hardest. You can use a race as some sort of redemption, even for other things that happened. I needed to finish UTMB before everything else in my life continued. Running it in 2025 was not just running a race; it was something bigger.',
          },
          {
            answer:
              'I had a miscarriage that February. When it happened, I was like, “I am going to get back on my feet. I am going to rebuild my strength and my body, and I am going to run again that same year.” I wanted to do that big thing and then feel more at peace entering the journey of motherhood. It was not just an achievement or running a hundred miles. I wanted something for me and for my future kids.',
          },
          {
            answer:
              'When I started talking about it with a friend, we realized that both of us were doing the race for reasons bigger than the finish. We said, “Let us help each other.” My mom knew what I had been through that year. She knew it was tough mentally and physically: being pregnant, feeling pregnant, losing a baby, and figuring things out when your body is hurt. I wanted proof that I was strong enough to go through those things and rebuild.',
          },
          {
            answer:
              'When I crossed the finish line, the intensity was not, “Congratulations, you ran another hundred-miler.” My mom told me, “I know how much work it was to be here today, on your two feet, healthy and ready to run a hundred miles, knowing that was not how the year began.”',
          },
        ],
      },
    ],
    gallery: mathildeGallery,
  },
]

export const crewMemberById = new Map(
  crewMembers.map(member => [member.id, member]),
)

export const crewMemberIdByProfileName = new Map(
  crewMembers.map(member => [member.profileName.toLowerCase(), member.id]),
)
