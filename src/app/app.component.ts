import { Inject } from '@angular/core';
import { Component } from '@angular/core';
import { ChatService, ChatServiceToken } from 'projects/ngx-chat/src/public-api';
import { TestLibService } from 'projects/test-lib/src/public-api';
const { client, xml } = require( "@xmpp/client" );
import setupRoster from "@xmpp-plugins/roster"
import { ChatAdapter, ChatParticipantStatus, ChatParticipantType, Message, ParticipantResponse } from 'ng-chat';
import { from, Observable, of } from 'rxjs';
import { map, tap } from 'rxjs/operators';

class MyAdapter extends ChatAdapter {
	roster;
	contacts: ParticipantResponse[];
	
	constructor(private xmpp) {
		super();
		this.roster = setupRoster( xmpp )
		this.roster.on( 'set', ( { item, version } ) => {
			console.log( `Roster version ${version} received`, item )
		} )
		xmpp.on( "stanza", async ( stanza ) => {
			if ( stanza.is( "message" ) ) {
				this.messageReceived( stanza );
				// await xmpp.send( xml( "presence", { type: "unavailable" } ) );
				// await xmpp.stop();
			}
		} );
	}

	messageReceived( stanza ) {
		let replyMessage = new Message();
		replyMessage.message = stanza.getChild( 'body' ).text();
		replyMessage.dateSent = new Date();
		const to = stanza.attrs.from.split( '@' )[0];
		console.log( to, replyMessage.message)
		const p = this.contacts.find( x => x.participant.id === to );
		this.messageReceivedHandler( p.participant, replyMessage );
	}

	listFriends(): Observable<ParticipantResponse[]> {
		return from( this.roster.get() as Promise<any> ).pipe(
			// tap( console.log ),
			map( ( a: any ) => a.items.map( x => {
				const pr = new ParticipantResponse();
				pr.participant = {
					participantType: ChatParticipantType.User,
					id: x.name,
					displayName: x.name,
					avatar: "https://66.media.tumblr.com/avatar_9dd9bb497b75_128.pnj",
					status: ChatParticipantStatus.Online,
				};
				return pr;
			} ) ),
			tap(x=>this.contacts = x),
		);
	}
	getMessageHistory( destinataryId: any ): Observable<Message[]> {
		return of([]);
	}
	sendMessage( message: Message ): void {
		// Sends a chat message to itself
		const m = xml(
			message.message,
			{ type: "chat", to: message.toId },
			xml( "body", {}, "hello world" ),
		);
		this.xmpp.send( m );
	}
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
	public adapter: ChatAdapter;
	userId = 'paul.garner_pavementsoft_com';

	constructor( @Inject( ChatServiceToken ) chatService: ChatService ) {
		// chatService.logIn( {
		// 	domain: '22.pss.com',
		// 	service: 'ws://localhost:5290',
		// 	password: '3fcb7c93-5794-4fe4-b7c2-e3d923e433da',
		// 	username: 'paul.garner_pavementsoft_com@22.pss.com',
		// } );
		// return;
		const xmpp = client( {
			service: "ws://localhost:5290",
			domain: "22.pss.com",
			// resource: "example",
			username: "paul.garner_pavementsoft_com",
			password: "3fcb7c93-5794-4fe4-b7c2-e3d923e433da",
		} );

		xmpp.on( "error", ( err ) => {
			console.error( err );
		} );

		xmpp.on( "offline", () => {
			console.log( "offline" );
		} );

		// xmpp.on( "stanza", async ( stanza ) => {
		// 	if ( stanza.is( "message" ) ) {
		// 		console.log('message', stanza)
		// 		// await xmpp.send( xml( "presence", { type: "unavailable" } ) );
		// 		// await xmpp.stop();
		// 	}
		// } );

		xmpp.on( "online", async ( address ) => {
			console.log( "online" );
			// Makes itself available
			await xmpp.send( xml( "presence" ) );
			this.adapter = new MyAdapter(xmpp);

		} );

		xmpp.start().catch( console.error );
	}
}
